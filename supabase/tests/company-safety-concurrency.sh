#!/bin/bash
# =========================================================
# 企業安全管理: 同時実行（競合）テスト
#
# organization advisory lockによる直列化が、実際に別々のDB接続
# （別プロセス・別トランザクション）の間で機能していることを検証する。
# 2本のpsqlプロセスをシェルレベルで並列起動し、Postgres自身の
# advisory lockによる直列化を通じて「後から実行された側は、先に実行
# された側がコミットした後の最新状態を見て判定する」ことを確認する。
# （dblink拡張は、supabase CLIローカルスタックのロール権限・認証方式の
# 差異により安定して使えなかったため、シェルレベルの並列psqlに変更した）
#
# 検証する競合パターン:
#   1. block_company_calls と create_company_checked の同時実行
#   2. block_company_calls と update_company_checked の同時実行
#   3. block_company_calls と create_companies_checked（CSV update）の同時実行
#   4. unblock_company_calls と update_company_checked の同時実行
#   5. record_call と block_company_calls の同時実行
#   6. unblock_company_calls と record_call の同時実行
#   7. 同一の新規識別子への同時登録（create_company_checked同士の競合）
#
# 使い方: ./company-safety-concurrency.sh "$DB_URL"
# ローカル／隔離環境専用。本番Supabaseでは絶対に実行しないこと。
# =========================================================
set -euo pipefail

DB_URL="${1:?usage: company-safety-concurrency.sh <DB_URL>}"
FAIL=0

run_as() {
  # $1 = auth.uid()として使うユーザーID, $2 = 実行するSQL（1文）
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -t -A <<SQL
set role authenticated;
set request.jwt.claim.sub = '$1';
$2
SQL
}

check() {
  # $1 = ラベル, $2 = 条件が真ならFAIL, $3 = FAILメッセージ
  if [ "$2" = "1" ]; then
    echo "FAIL[$1]: $3" >&2
    FAIL=1
  else
    echo "PASS[$1]: $3"
  fi
}

echo "=== seed ==="
psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
insert into public.organizations (id, name) values ('a0000000-0000-0000-0000-00000000000a','テスト組織A');
insert into auth.users (id, email) values
  ('a1111111-1111-1111-1111-111111111111','admin-a@test.local'),
  ('a2222222-2222-2222-2222-222222222222','member-a@test.local');
insert into public.profiles (id, organization_id, full_name, role, active) values
  ('a1111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-00000000000a','管理者A','admin',true),
  ('a2222222-2222-2222-2222-222222222222','a0000000-0000-0000-0000-00000000000a','メンバーA','member',true);
insert into public.companies (id, organization_id, name, phone, location, owner_id) values
  ('c0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','競合テスト企業1','03-1111-1111','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-00000000000a','競合テスト企業2','03-2222-2222','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-00000000000a','競合テスト企業3','03-3333-3333','東京都','a1111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-00000000000a','競合テスト企業4','03-4444-4444','東京都','a1111111-1111-1111-1111-111111111111');
SQL

echo "=== 競合1: block_company_calls と create_company_checked の同時実行 ==="
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000001', p_match_scope:='phone', p_reason:='競合1テスト');" \
  > /tmp/comp1_a.log 2>/tmp/comp1_a.err &
PID_A=$!
sleep 0.3
run_as 'a2222222-2222-2222-2222-222222222222' \
  "select public.create_company_checked(p_name:='競合1の新規登録', p_phone:='03-1111-1111', p_website_url:=null, p_location:='東京都');" \
  > /tmp/comp1_b.log 2>/tmp/comp1_b.err &
PID_B=$!
wait "$PID_A" "$PID_B"
R1=$(cat /tmp/comp1_b.log)
case "$R1" in
  *'"status": "blocked"'*) check "競合1" 0 "organization lockにより直列化され、後発のcreateはblockedと正しく判定された" ;;
  *) check "競合1" 1 "block_company_callsコミット後にもかかわらずcreate_company_checkedがblockedになりませんでした（結果: $R1）" ;;
esac

echo "=== 競合2: block_company_calls と update_company_checked の同時実行 ==="
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000002', p_match_scope:='phone', p_reason:='競合2テスト');" \
  > /tmp/comp2_a.log 2>/tmp/comp2_a.err &
PID_A=$!
sleep 0.3
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.update_company_checked('c0000000-0000-0000-0000-000000000002'::uuid, '{\"memo\":\"競合2更新試行\"}'::jsonb, 'skip');" \
  > /tmp/comp2_b.log 2>/tmp/comp2_b.err &
PID_B=$!
wait "$PID_A" "$PID_B"
R2=$(cat /tmp/comp2_b.log)
MEMO2=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select memo from public.companies where id='c0000000-0000-0000-0000-000000000002';")
if [[ "$R2" == *'"status": "blocked"'* && "$MEMO2" != "競合2更新試行" ]]; then
  check "競合2" 0 "直列化により後発のupdateはblockedと正しく判定され、実データも更新されていない"
else
  check "競合2" 1 "update_company_checkedの結果またはmemoの状態が期待と異なる（結果: $R2, memo: $MEMO2）"
fi

echo "=== 競合3: block_company_calls と create_companies_checked（CSV update）の同時実行 ==="
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000003', p_match_scope:='phone', p_reason:='競合3テスト');" \
  > /tmp/comp3_a.log 2>/tmp/comp3_a.err &
PID_A=$!
sleep 0.3
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.create_companies_checked('[{\"name\":\"競合テスト企業3\",\"phone\":\"03-3333-3333\",\"location\":\"東京都\",\"memo\":\"競合3更新試行\"}]'::jsonb, 'update');" \
  > /tmp/comp3_b.log 2>/tmp/comp3_b.err &
PID_B=$!
wait "$PID_A" "$PID_B"
R3=$(cat /tmp/comp3_b.log)
MEMO3=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select memo from public.companies where id='c0000000-0000-0000-0000-000000000003';")
if [[ "$R3" == *'"status": "blocked"'* && "$MEMO3" != "競合3更新試行" ]]; then
  check "競合3" 0 "CSV一括updateも直列化により禁止判定を回避できない"
else
  check "競合3" 1 "CSV一括updateの結果またはmemoの状態が期待と異なる（結果: $R3, memo: $MEMO3）"
fi

echo "=== 競合4: unblock_company_calls と update_company_checked の同時実行 ==="
BLOCK_ID_1=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select id from public.call_blocklist where company_id='c0000000-0000-0000-0000-000000000001' and active;")
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.unblock_company_calls('$BLOCK_ID_1'::uuid, '競合4解除テスト');" \
  > /tmp/comp4_a.log 2>/tmp/comp4_a.err &
PID_A=$!
sleep 0.3
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.update_company_checked('c0000000-0000-0000-0000-000000000001'::uuid, '{\"memo\":\"競合4更新試行\"}'::jsonb, 'skip');" \
  > /tmp/comp4_b.log 2>/tmp/comp4_b.err &
PID_B=$!
wait "$PID_A" "$PID_B"
R4=$(cat /tmp/comp4_b.log)
MEMO4=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select memo from public.companies where id='c0000000-0000-0000-0000-000000000001';")
if [[ "$R4" == *'"status": "updated"'* && "$MEMO4" == "競合4更新試行" ]]; then
  check "競合4" 0 "unblockが先にコミットされていれば、後発のupdateは正常に成功する"
else
  check "競合4" 1 "unblock後のupdateが期待通り成功していない（結果: $R4, memo: $MEMO4）"
fi

echo "=== 競合5: record_call と block_company_calls の同時実行 ==="
# 企業4を使用する（企業2は競合2で既にblock済みのまま残っており、record_callの
# 「開始時点では未禁止」という前提が崩れてしまうため、この競合専用の未使用企業を使う）
run_as 'a2222222-2222-2222-2222-222222222222' \
  "select public.record_call('c0000000-0000-0000-0000-000000000004'::uuid, '再架電', '競合5架電テスト');" \
  > /tmp/comp5_a.log 2>/tmp/comp5_a.err &
PID_A=$!
sleep 0.3
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.block_company_calls(p_company_id:='c0000000-0000-0000-0000-000000000004', p_match_scope:='phone', p_reason:='競合5禁止テスト');" \
  > /tmp/comp5_b.log 2>/tmp/comp5_b.err &
PID_B=$!
wait "$PID_A" "$PID_B"
LOG_CNT=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select count(*) from public.call_logs where company_id='c0000000-0000-0000-0000-000000000004' and note='競合5架電テスト';")
PROHIBITED=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select call_prohibited from public.companies_with_call_status where id='c0000000-0000-0000-0000-000000000004';")
if [ "$LOG_CNT" = "1" ] && [ "$PROHIBITED" = "t" ]; then
  check "競合5" 0 "record_callとblock_company_callsは直列化され、両方とも矛盾なく完了した（デッドロック無し）"
else
  check "競合5" 1 "架電記録数(${LOG_CNT})またはcall_prohibited(${PROHIBITED})が期待と異なる"
fi

echo "=== 競合6: unblock_company_calls と record_call の同時実行 ==="
BLOCK_ID_2=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select id from public.call_blocklist where company_id='c0000000-0000-0000-0000-000000000004' and active;")
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.unblock_company_calls('$BLOCK_ID_2'::uuid, '競合6解除テスト');" \
  > /tmp/comp6_a.log 2>/tmp/comp6_a.err &
PID_A=$!
sleep 0.3
run_as 'a2222222-2222-2222-2222-222222222222' \
  "select public.record_call('c0000000-0000-0000-0000-000000000004'::uuid, '再架電', '競合6架電テスト');" \
  > /tmp/comp6_b.log 2>/tmp/comp6_b.err &
PID_B=$!
wait "$PID_A" "$PID_B"
LOG_CNT6=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select count(*) from public.call_logs where company_id='c0000000-0000-0000-0000-000000000004' and note='競合6架電テスト';")
if [ "$LOG_CNT6" = "1" ]; then
  check "競合6" 0 "unblockが先にコミットされていれば、後発のrecord_callは正常に成功する"
else
  check "競合6" 1 "unblock後のrecord_callが成功していない（架電記録数: ${LOG_CNT6}, stderr: $(cat /tmp/comp6_b.err)）"
fi

echo "=== 競合7: 同一の新規識別子への同時登録（create_company_checked同士の競合） ==="
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.create_company_checked(p_name:='同時登録テストA', p_phone:='090-7777-8888', p_website_url:=null, p_location:='東京都');" \
  > /tmp/comp7_a.log 2>/tmp/comp7_a.err &
PID_A=$!
run_as 'a1111111-1111-1111-1111-111111111111' \
  "select public.create_company_checked(p_name:='同時登録テストB', p_phone:='090-7777-8888', p_website_url:=null, p_location:='東京都');" \
  > /tmp/comp7_b.log 2>/tmp/comp7_b.err &
PID_B=$!
wait "$PID_A" "$PID_B"
CNT7=$(psql "$DB_URL" -v ON_ERROR_STOP=1 -t -A -c "select count(*) from public.companies where phone='090-7777-8888';")
R7A=$(cat /tmp/comp7_a.log); R7B=$(cat /tmp/comp7_b.log)
INSERTED_COUNT=0
[[ "$R7A" == *'"status": "inserted"'* ]] && INSERTED_COUNT=$((INSERTED_COUNT+1))
[[ "$R7B" == *'"status": "inserted"'* ]] && INSERTED_COUNT=$((INSERTED_COUNT+1))
SKIPPED_COUNT=0
[[ "$R7A" == *'"status": "skipped"'* ]] && SKIPPED_COUNT=$((SKIPPED_COUNT+1))
[[ "$R7B" == *'"status": "skipped"'* ]] && SKIPPED_COUNT=$((SKIPPED_COUNT+1))
if [ "$CNT7" = "1" ] && [ "$INSERTED_COUNT" = "1" ] && [ "$SKIPPED_COUNT" = "1" ]; then
  check "競合7" 0 "同一識別子への同時登録は、片方だけがinsertedになりもう片方はskippedになる（重複防止が機能している）"
else
  check "競合7" 1 "同時登録の結果、企業が${CNT7}件登録されています（1件のはず。A: $R7A, B: $R7B）"
fi

echo "=== ALL CONCURRENCY ASSERTIONS EXECUTED ==="
exit "$FAIL"
