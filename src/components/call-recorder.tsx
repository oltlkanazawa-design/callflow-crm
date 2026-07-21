"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from "react";
import { Mic, Circle, Play, Download, Trash2, Square, AlertTriangle } from "lucide-react";
import {
  transition, canStartTest, canStartRecording, canStopRecording, canChangeMicrophone, isLocked, hasPendingRecording,
  pickSupportedMimeType, formatElapsedTime, formatFileSize, buildRecordingFileName,
  isOverMaxDuration, isOverMaxSize, classifyVolumeLevel, isSameCompany,
  TEST_RECORDING_MS, RECORDING_TIMESLICE_MS,
  type RecorderState,
} from "@/lib/call-recorder";

export interface CallRecorderLockState {
  /** trueの間は録音中（ハードロック。画面遷移・ログアウトを完全に禁止する）。 */
  isRecording: boolean;
  /** trueの間は保存前の録音済み音声が残っている（ソフトロック。移動前に破棄確認が必要）。 */
  hasPendingAudio: boolean;
}

export interface CallRecorderHandle {
  /** 保存前の録音済み音声を強制的に破棄する（画面遷移の確認後に呼び出す）。 */
  discardRecording: () => void;
}

interface Props {
  companyId?: string;
  onLockChange: (lock: CallRecorderLockState) => void;
  notify: (message: string) => void;
}

type MicSettings = { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };
const DEFAULT_MIC_SETTINGS: MicSettings = { echoCancellation: false, noiseSuppression: true, autoGainControl: true };

/** 録音経過時間の計測用。イベントハンドラ内の時刻取得をコンポーネント本体から切り離すためのヘルパー。 */
function nowMs(): number {
  return Date.now();
}

const ERROR_MESSAGES: Record<string, string> = {
  unsupported: "このブラウザは録音機能に対応していません。最新のGoogle Chromeでお試しください。",
  permission_denied: "マイクの使用が許可されていません。Chromeのアドレスバー左側からマイクを許可してください。",
  no_microphone: "マイクが見つかりません。Macにマイクが接続・内蔵されているか確認してください。",
  device_disconnected: "使用中のマイクが切断されました。マイクを確認し、もう一度お試しください。",
  recorder_create_failed: "録音の準備に失敗しました。ページを再読み込みしてお試しください。",
  start_failed: "録音を開始できませんでした。マイクが他のアプリで使用されていないか確認してください。",
  recording_interrupted: "録音が中断されました。それまでの音声は再生・保存できます。",
  max_duration: "録音時間が60分に達したため、録音を自動的に停止しました。",
  max_size: "録音データが100MBに達したため、録音を自動的に停止しました。",
  playback_failed: "音声の再生に失敗しました。",
  audio_context_failed: "音量メーターの初期化に失敗しました。録音自体は継続できます。",
};

function isRecorderSupported(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(navigator.mediaDevices && window.MediaRecorder);
}

const CallRecorder = forwardRef<CallRecorderHandle, Props>(function CallRecorder({ companyId, onLockChange, notify }, ref) {
  const [state, setState] = useState<RecorderState>(() => (isRecorderSupported() ? "idle" : "unsupported"));
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [micSettings, setMicSettings] = useState<MicSettings>(DEFAULT_MIC_SETTINGS);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordedBytes, setRecordedBytes] = useState(0);
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [testUrl, setTestUrl] = useState<string | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const testTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingCompanyIdRef = useRef<string | null>(null);
  const isTestModeRef = useRef(false);

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const dispatch = (event: Parameters<typeof transition>[1]) => setState((s) => transition(s, event));

  // ---------------------------------------------------------
  // 音量メーターの停止・AudioContextの解放
  // ---------------------------------------------------------
  const stopVolumeMeter = () => {
    if (rafIdRef.current !== null) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
    analyserRef.current = null;
    if (audioContextRef.current) { audioContextRef.current.close().catch(() => {}); audioContextRef.current = null; }
    setVolumeLevel(0);
  };

  const startVolumeMeter = (stream: MediaStream) => {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
        setVolumeLevel(peak);
        rafIdRef.current = requestAnimationFrame(tick);
      };
      rafIdRef.current = requestAnimationFrame(tick);
    } catch {
      setErrorCode("audio_context_failed");
    }
  };

  // ---------------------------------------------------------
  // マイク一覧の取得
  // ---------------------------------------------------------
  const refreshDevices = async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const mics = list.filter((d) => d.kind === "audioinput");
      setDevices(mics);
      return mics;
    } catch {
      return [];
    }
  };

  useEffect(() => {
    if (!isRecorderSupported()) return;
    const onDeviceChange = async () => {
      const mics = await refreshDevices();
      if (!canChangeMicrophone(stateRef.current)) return;
      if (selectedDeviceId && !mics.some((m) => m.deviceId === selectedDeviceId)) {
        if (mics.length > 0) {
          setSelectedDeviceId(mics[0].deviceId);
          notify("使用していたマイクが利用できなくなったため、別のマイクへ切り替えました");
        } else {
          setSelectedDeviceId("");
          setErrorCode("no_microphone");
        }
      }
    };
    navigator.mediaDevices.addEventListener?.("devicechange", onDeviceChange);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeviceId]);

  // ---------------------------------------------------------
  // マイク権限の要求
  // ---------------------------------------------------------
  const requestPermission = async () => {
    if (!isRecorderSupported()) { setState("unsupported"); return; }
    dispatch({ type: "REQUEST_PERMISSION" });
    setErrorCode(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      const mics = await refreshDevices();
      if (mics.length === 0) { setErrorCode("no_microphone"); dispatch({ type: "PERMISSION_DENIED" }); return; }
      setSelectedDeviceId((prev) => prev || mics[0].deviceId);
      const mime = pickSupportedMimeType((m) => window.MediaRecorder?.isTypeSupported?.(m) ?? false);
      setMimeType(mime);
      dispatch({ type: "PERMISSION_GRANTED" });
    } catch {
      setErrorCode("permission_denied");
      dispatch({ type: "PERMISSION_DENIED" });
    }
  };

  const openStream = async (): Promise<MediaStream> => {
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
        echoCancellation: micSettings.echoCancellation,
        noiseSuppression: micSettings.noiseSuppression,
        autoGainControl: micSettings.autoGainControl,
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        setErrorCode("device_disconnected");
        stopEverything();
        dispatch({ type: "ERROR" });
      };
    });
    return stream;
  };

  const stopEverything = () => {
    if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null; }
    if (testTimeoutRef.current) { clearTimeout(testTimeoutRef.current); testTimeoutRef.current = null; }
    stopVolumeMeter();
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try { recorderRef.current.stop(); } catch { /* 既に停止している場合は無視 */ }
    }
    recorderRef.current = null;
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
  };

  // ---------------------------------------------------------
  // 5秒マイクテスト
  // ---------------------------------------------------------
  const startTest = async () => {
    if (!canStartTest(state)) return;
    setErrorCode(null);
    if (testUrl) { URL.revokeObjectURL(testUrl); setTestUrl(null); }
    try {
      const stream = await openStream();
      streamRef.current = stream;
      startVolumeMeter(stream);
      isTestModeRef.current = true;
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunks, mimeType ? { type: mimeType } : undefined);
        setTestUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        stopVolumeMeter();
        dispatch({ type: "TEST_COMPLETE" });
      };
      recorder.start(RECORDING_TIMESLICE_MS);
      dispatch({ type: "START_TEST" });
      testTimeoutRef.current = setTimeout(() => {
        if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
      }, TEST_RECORDING_MS);
    } catch {
      setErrorCode("start_failed");
      dispatch({ type: "ERROR" });
    }
  };

  const discardTest = () => {
    if (testUrl) { URL.revokeObjectURL(testUrl); setTestUrl(null); }
    dispatch({ type: "DISCARD_TEST" });
  };

  // ---------------------------------------------------------
  // 本番録音
  // ---------------------------------------------------------
  const startRecording = async () => {
    if (!canStartRecording(state)) return;
    setErrorCode(null);
    if (recordingUrl) { URL.revokeObjectURL(recordingUrl); setRecordingUrl(null); }
    try {
      const stream = await openStream();
      streamRef.current = stream;
      startVolumeMeter(stream);
      isTestModeRef.current = false;
      recordingCompanyIdRef.current = companyId ?? null;
      chunksRef.current = [];
      setRecordedBytes(0);
      setElapsedMs(0);
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size <= 0) return;
        chunksRef.current.push(e.data);
        setRecordedBytes((prev) => {
          const next = prev + e.data.size;
          if (isOverMaxSize(next)) { setErrorCode("max_size"); stopRecording(); }
          return next;
        });
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, mimeType ? { type: mimeType } : undefined);
        setRecordingUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        stopVolumeMeter();
        if (elapsedTimerRef.current) { clearInterval(elapsedTimerRef.current); elapsedTimerRef.current = null; }
        dispatch({ type: "STOP_RECORDING" });
      };
      recorder.start(RECORDING_TIMESLICE_MS);
      startedAtRef.current = nowMs();
      dispatch({ type: "START_RECORDING" });
      elapsedTimerRef.current = setInterval(() => {
        const elapsed = nowMs() - startedAtRef.current;
        setElapsedMs(elapsed);
        if (isOverMaxDuration(elapsed)) { setErrorCode("max_duration"); stopRecording(); }
      }, 500);
    } catch {
      setErrorCode("start_failed");
      dispatch({ type: "ERROR" });
    }
  };

  const stopRecording = () => {
    if (!canStopRecording(stateRef.current)) return;
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
  };

  const discardRecording = () => {
    if (recordingUrl) { URL.revokeObjectURL(recordingUrl); setRecordingUrl(null); }
    recordingCompanyIdRef.current = null;
    setElapsedMs(0);
    setRecordedBytes(0);
    dispatch({ type: "DISCARD_RECORDING" });
  };

  // discardRecordingはrecordingUrlを参照するクロージャのため、recordingUrl更新のたびに
  // ハンドルを作り直す（discardRecording自体はrender毎に再生成される非安定な関数のため依存に含めない）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useImperativeHandle(ref, () => ({ discardRecording }), [recordingUrl]);

  const downloadRecording = () => {
    if (!recordingUrl) return;
    const a = document.createElement("a");
    a.href = recordingUrl;
    a.download = buildRecordingFileName(new Date(), mimeType);
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // ---------------------------------------------------------
  // 企業の取り違え防止：想定外に企業が変わった場合は安全のため強制破棄する
  // ---------------------------------------------------------
  const forceDiscardForSafety = useCallback(() => {
    stopEverything();
    setRecordingUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    recordingCompanyIdRef.current = null;
    setState("ready");
    notify("表示中の企業が変わったため、安全のため録音を破棄しました");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify]);

  useEffect(() => {
    if (recordingCompanyIdRef.current && !isSameCompany(recordingCompanyIdRef.current, companyId)) {
      forceDiscardForSafety();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  // ---------------------------------------------------------
  // ロック状態を親へ通知
  // ---------------------------------------------------------
  useEffect(() => {
    onLockChange({ isRecording: isLocked(state), hasPendingAudio: hasPendingRecording(state) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // ---------------------------------------------------------
  // アンマウント時の後始末
  // ---------------------------------------------------------
  useEffect(() => {
    return () => {
      stopEverything();
      if (testUrl) URL.revokeObjectURL(testUrl);
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const volumeHint = useMemo(() => classifyVolumeLevel(volumeLevel), [volumeLevel]);

  if (state === "unsupported") {
    return <RecorderNotice tone="warning">{ERROR_MESSAGES.unsupported}</RecorderNotice>;
  }

  return (
    <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50/60 p-4">
      <div className="mb-2 flex items-center justify-between">
        <b className="flex items-center gap-1.5 text-xs text-blue-700"><Mic size={14} />通話録音（テスト中）</b>
        {mimeType && <span className="text-[9px] text-slate-400">形式: {mimeType}</span>}
      </div>
      <p className="mb-3 text-[10px] leading-5 text-slate-500">
        録音機能は現在テスト中です。録音した音声はブラウザ内だけに保持され、外部には送信されません。
      </p>

      {errorCode && (
        <RecorderNotice tone="error">
          {ERROR_MESSAGES[errorCode] || "エラーが発生しました。もう一度お試しください。"}
        </RecorderNotice>
      )}

      {(state === "idle" || state === "requesting_permission") && (
        <button className="btn btn-light w-full text-xs" disabled={state === "requesting_permission"} onClick={requestPermission}>
          {state === "requesting_permission" ? "マイクを確認しています…" : "マイクを確認"}
        </button>
      )}

      {state !== "idle" && state !== "requesting_permission" && devices.length > 0 && (
        <div className="mb-3">
          <label className="mb-1 block text-[10px] font-bold text-slate-500">使用するマイク</label>
          <select
            className="input text-xs"
            value={selectedDeviceId}
            disabled={!canChangeMicrophone(state)}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
          >
            {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || "マイク"}</option>)}
          </select>
        </div>
      )}

      {(state === "ready" || state === "testing" || state === "test_recorded") && (
        <div className="mb-3">
          <button className="text-[10px] font-bold text-blue-600 underline" onClick={() => setShowAdvanced((v) => !v)}>
            詳細設定 {showAdvanced ? "▲" : "▼"}
          </button>
          {showAdvanced && (
            <div className="mt-2 space-y-2 rounded-lg bg-white p-3 text-[10px]">
              <MicToggle
                label="エコー除去" hint="iPhoneのスピーカー通話音声が消えることがあるため、既定はオフです"
                checked={micSettings.echoCancellation} disabled={!canChangeMicrophone(state)}
                onChange={(v) => setMicSettings((s) => ({ ...s, echoCancellation: v }))}
              />
              <MicToggle
                label="ノイズ抑制" hint="周囲の雑音を減らします"
                checked={micSettings.noiseSuppression} disabled={!canChangeMicrophone(state)}
                onChange={(v) => setMicSettings((s) => ({ ...s, noiseSuppression: v }))}
              />
              <MicToggle
                label="自動音量調整" hint="声の大きさを自動的に均一化します"
                checked={micSettings.autoGainControl} disabled={!canChangeMicrophone(state)}
                onChange={(v) => setMicSettings((s) => ({ ...s, autoGainControl: v }))}
              />
            </div>
          )}
        </div>
      )}

      {(state === "testing" || state === "recording") && (
        <div className="mb-3">
          <VolumeMeter level={volumeLevel} />
          {volumeHint === "low" && <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-600"><AlertTriangle size={11} />音量が小さいかもしれません</p>}
        </div>
      )}

      {(state === "ready" || state === "test_recorded") && (
        <button className="btn btn-light mb-2 w-full text-xs" onClick={startTest}>
          <Circle size={12} className="mr-1 inline text-emerald-500" />5秒マイクテスト
        </button>
      )}
      {state === "testing" && (
        <div className="mb-2 rounded-lg bg-white p-3 text-center text-xs font-bold text-slate-600">テスト録音中…（自動的に5秒で停止します）</div>
      )}
      {state === "test_recorded" && testUrl && (
        <div className="mb-3 rounded-lg bg-white p-3">
          <p className="mb-2 text-[10px] font-bold text-slate-600">テスト音声</p>
          <audio className="w-full" controls src={testUrl} />
          <button className="mt-2 text-[10px] font-bold text-red-600" onClick={discardTest}><Trash2 size={11} className="mr-1 inline" />テスト音声を破棄</button>
        </div>
      )}

      {(state === "ready" || state === "test_recorded") && (
        <button className="btn btn-primary w-full text-xs" onClick={() => {
          const ok = window.confirm("通話録音を開始します。\n録音に関する社内ルールと、必要な相手への案内を確認してください。");
          if (ok) startRecording();
        }}>
          通話を録音する
        </button>
      )}

      {state === "recording" && (
        <div className="rounded-lg border border-red-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-extrabold text-red-600">
              <Circle size={10} className="animate-pulse fill-red-600 text-red-600" />録音中 {formatElapsedTime(elapsedMs)}
            </span>
            <span className="text-[10px] text-slate-400">{formatFileSize(recordedBytes)}</span>
          </div>
          <VolumeMeter level={volumeLevel} />
          <p className="mt-2 text-[9px] text-slate-400">マイク: {devices.find((d) => d.deviceId === selectedDeviceId)?.label || "選択中のマイク"}</p>
          <button className="btn mt-2 w-full bg-red-600 text-xs text-white hover:bg-red-700" onClick={stopRecording}>
            <Square size={12} className="mr-1 inline" />録音停止
          </button>
        </div>
      )}

      {state === "recorded" && recordingUrl && (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="mb-1 text-[10px] text-slate-500">
            録音時間 {formatElapsedTime(elapsedMs)} ／ {formatFileSize(recordedBytes)} ／ {mimeType || "既定形式"}
          </p>
          <audio className="w-full" controls src={recordingUrl} />
          <p className="mt-2 rounded bg-slate-50 p-2 text-[10px] text-slate-500">文字起こし・解析は次のPhaseで追加します</p>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <button className="btn btn-light !py-1.5 text-[10px]" onClick={downloadRecording}><Download size={12} className="mr-1 inline" />保存</button>
            <button className="btn btn-light !py-1.5 text-[10px]" onClick={() => {
              const el = document.querySelector<HTMLAudioElement>('audio[src="' + recordingUrl + '"]');
              if (!el) return;
              if (el.paused) { el.play().catch(() => setErrorCode("playback_failed")); } else { el.pause(); }
            }}><Play size={12} className="mr-1 inline" />再生</button>
            <button className="btn btn-light !py-1.5 text-[10px] text-red-600" onClick={() => {
              if (window.confirm("録音した音声を破棄します。よろしいですか？")) discardRecording();
            }}><Trash2 size={12} className="mr-1 inline" />破棄</button>
          </div>
        </div>
      )}

      {state === "error" && (
        <button className="btn btn-light w-full text-xs" onClick={() => { setErrorCode(null); dispatch({ type: "RESET" }); }}>
          最初からやり直す
        </button>
      )}
    </div>
  );
});

export default CallRecorder;

function RecorderNotice({ tone, children }: { tone: "warning" | "error"; children: React.ReactNode }) {
  return (
    <div className={`mb-3 flex items-start gap-1.5 rounded-lg p-2.5 text-[10px] leading-5 ${tone === "error" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-700"}`}>
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function VolumeMeter({ level }: { level: number }) {
  const pct = Math.min(100, Math.round(level * 100 * 3));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full transition-[width] ${pct < 5 ? "bg-slate-300" : pct < 15 ? "bg-amber-400" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function MicToggle({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b className="block text-slate-700">{label}</b>
        <span className="text-slate-400">{hint}</span>
      </span>
    </label>
  );
}
