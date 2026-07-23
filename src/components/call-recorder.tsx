"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from "react";
import { Mic, Circle, Play, Download, Trash2, Square, AlertTriangle, Wifi, WifiOff, Send, KeyRound, Unplug, FileText, Copy, X, Sparkles, ArrowRightCircle } from "lucide-react";
import {
  transition, canStartTest, canStartRecording, canStopRecording, canChangeMicrophone, isLocked, hasPendingRecording,
  pickSupportedMimeType, formatElapsedTime, formatFileSize, buildRecordingFileName,
  isOverMaxDuration, isOverMaxSize, classifyVolumeLevel, isSameCompany,
  TEST_RECORDING_MS, RECORDING_TIMESLICE_MS,
  type RecorderState,
} from "@/lib/call-recorder";
import {
  getCompanionBaseUrl, loadStoredToken, storeToken, clearStoredToken,
  checkCompanionHealth, pairWithCompanion, uploadRecordingToCompanion, generateRecordingId,
  companionErrorMessage, type CompanionUploadResult,
  createTranscriptionJob, pollTranscriptionJob, cancelTranscriptionJob, type TranscriptionJobView,
  createAnalysisJob, pollAnalysisJob, cancelAnalysisJob, type AnalysisJobView, type CallAnalysisResult,
} from "@/lib/companion-client";
import { splitAnalysisDateTime, combineDateTime } from "@/lib/analysis-datetime";

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

/** 「架電フォームへ反映」で親（CallScreen）へ渡す内容。担当者名は自動上書きせず参考情報として扱う。 */
export interface AppliedAnalysisFields {
  result: string;
  heat: string;
  applyHeat: boolean;
  summary: string;
  contactName: string | null;
  challenges: string[];
  nextAction: string;
  nextActionAt: string | null;
  transcript: string;
}

interface Props {
  companyId?: string;
  onLockChange: (lock: CallRecorderLockState) => void;
  notify: (message: string) => void;
  onApplyToForm?: (fields: AppliedAnalysisFields) => void;
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

const CALL_COMPANION_ENABLED = process.env.NEXT_PUBLIC_CALL_COMPANION_ENABLED === "true";

const COMPANION_CONSENT_MESSAGE =
  "録音音声を、このMac上で動いているCallFlow Companionへ送信します。\n" +
  "音声はMac内で一時保存され、受信確認後に削除されます。\n" +
  "SupabaseやVercelには送信されません。";

type CompanionSendState = "idle" | "uploading" | "success" | "error";

type TranscriptionUiState = "idle" | "uploading" | "converting" | "transcribing" | "completed" | "failed" | "cancelled";

const TRANSCRIPTION_PROGRESS_MESSAGES: Partial<Record<TranscriptionUiState, string>> = {
  uploading: "音声をMacへ送信しています",
  converting: "音声を変換しています",
  transcribing: "文字起こししています",
};

const CALL_ANALYSIS_ENABLED = process.env.NEXT_PUBLIC_CALL_ANALYSIS_ENABLED === "true";

const ANALYSIS_CONSENT_MESSAGE =
  "文字起こし文章をCodexへ送信し、営業内容を解析します。\n" +
  "音声ファイルは送信されません。\n" +
  "解析結果は確認するまで架電記録へ反映されません。";

type AnalysisUiState = "idle" | "checking_auth" | "starting_codex" | "analyzing" | "validating" | "completed" | "failed" | "cancelled";

const ANALYSIS_PROGRESS_MESSAGES: Partial<Record<AnalysisUiState, string>> = {
  checking_auth: "Codexのログイン状態を確認しています",
  starting_codex: "解析を開始しています",
  analyzing: "営業内容を整理しています",
  validating: "結果を確認しています",
};

const ANALYSIS_RESULT_OPTIONS = ["アポ獲得", "資料送付", "再架電", "担当者不在", "見込みなし", "その他"] as const;
const ANALYSIS_HEAT_OPTIONS = ["高", "中", "低"] as const;

const CallRecorder = forwardRef<CallRecorderHandle, Props>(function CallRecorder({ companyId, onLockChange, notify, onApplyToForm }, ref) {
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

  // ---------------------------------------------------------
  // Companion（Mac上のローカル処理アプリ）連携用の状態
  // ---------------------------------------------------------
  const [companionToken, setCompanionToken] = useState<string | null>(() => (CALL_COMPANION_ENABLED ? loadStoredToken() : null));
  const [companionChecking, setCompanionChecking] = useState(false);
  const [showPairingForm, setShowPairingForm] = useState(false);
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [sendState, setSendState] = useState<CompanionSendState>("idle");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<CompanionUploadResult | null>(null);

  // ---------------------------------------------------------
  // 文字起こし（Phase 3B）用の状態。文字起こし結果はメモリ内のみに保持し、
  // localStorage/sessionStorage/IndexedDBへは一切保存しない。
  // ---------------------------------------------------------
  const [transcriptionState, setTranscriptionState] = useState<TranscriptionUiState>("idle");
  const [transcriptionText, setTranscriptionText] = useState("");
  const [transcriptionModel, setTranscriptionModel] = useState<string | null>(null);
  const [transcriptionDurationMs, setTranscriptionDurationMs] = useState<number | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [transcriptionCopied, setTranscriptionCopied] = useState(false);

  // ---------------------------------------------------------
  // 営業通話解析（Phase 4、Codex連携）用の状態。解析結果はメモリ内のみに保持し、
  // 「架電フォームへ反映」を押すまでは架電記録に一切影響しない。
  // ---------------------------------------------------------
  const [analysisState, setAnalysisState] = useState<AnalysisUiState>("idle");
  const [analysisResult, setAnalysisResult] = useState<CallAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisApplyHeat, setAnalysisApplyHeat] = useState(false);
  // 次回対応日は日付欄・時刻欄（任意）を独立したstateとして持つ（analysisResult.next_action_atから
  // 毎回分解し直すと、日付が未入力のまま時刻だけ入力した瞬間にcombineDateTimeがnullを返し、
  // 次の再描画で入力した時刻が消えてしまうため）。analysisResult.next_action_at自体は
  // applyAnalysisToFormが読み取る正規値として、変更のたびに同期して更新する。
  const [analysisNextDate, setAnalysisNextDate] = useState("");
  const [analysisNextTime, setAnalysisNextTime] = useState("");

  const recordingBlobRef = useRef<Blob | null>(null);
  const sentRecordingKeyRef = useRef<string | null>(null);
  const transcriptionJobIdRef = useRef<string | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const analysisJobIdRef = useRef<string | null>(null);
  const analysisAbortRef = useRef<AbortController | null>(null);

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

  // Companionのペアリング状態はuseStateの初期化関数でlocalStorageから復元する
  // （マウント時に一度だけ読めばよく、外部システムとの継続的な同期ではないためeffectは使わない）。

  const resetCompanionSendState = useCallback(() => {
    setSendState("idle");
    setSendError(null);
    setSendResult(null);
    sentRecordingKeyRef.current = null;
    recordingBlobRef.current = null;
  }, []);

  const resetAnalysisState = useCallback(() => {
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = null;
    analysisJobIdRef.current = null;
    setAnalysisState("idle");
    setAnalysisResult(null);
    setAnalysisError(null);
    setAnalysisApplyHeat(false);
    setAnalysisNextDate("");
    setAnalysisNextTime("");
  }, []);

  const resetTranscriptionState = useCallback(() => {
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    transcriptionJobIdRef.current = null;
    setTranscriptionState("idle");
    setTranscriptionText("");
    setTranscriptionModel(null);
    setTranscriptionDurationMs(null);
    setTranscriptionError(null);
    setTranscriptionCopied(false);
    resetAnalysisState();
  }, [resetAnalysisState]);

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
    resetCompanionSendState();
    resetTranscriptionState();
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
        recordingBlobRef.current = blob;
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
    resetCompanionSendState();
    resetTranscriptionState();
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
  // Companion（Mac上のローカル処理アプリ）連携
  // ---------------------------------------------------------
  const checkCompanionConnection = async () => {
    setCompanionChecking(true);
    try {
      const health = await checkCompanionHealth(getCompanionBaseUrl());
      notify(`Companionに接続できました（${health.secure ? "HTTPS" : "開発用HTTP"}・v${health.version}）`);
    } catch (error) {
      notify(companionErrorMessage(error));
    } finally {
      setCompanionChecking(false);
    }
  };

  const submitPairingCode = async () => {
    if (!/^\d{6}$/.test(pairingCodeInput)) {
      setPairingError("6桁の数字を入力してください");
      return;
    }
    setPairingBusy(true);
    setPairingError(null);
    try {
      const token = await pairWithCompanion(getCompanionBaseUrl(), pairingCodeInput);
      storeToken(token);
      setCompanionToken(token);
      setShowPairingForm(false);
      setPairingCodeInput("");
      notify("Macの処理アプリとペアリングしました");
    } catch (error) {
      setPairingError(companionErrorMessage(error));
    } finally {
      setPairingBusy(false);
    }
  };

  const unpairCompanion = () => {
    clearStoredToken();
    setCompanionToken(null);
    setShowPairingForm(false);
    notify("Companionとのペアリングを解除しました");
  };

  const sendRecordingToCompanion = async () => {
    if (!companionToken || !recordingBlobRef.current) return;
    if (!isSameCompany(recordingCompanyIdRef.current, companyId)) {
      notify("表示中の企業が録音時と異なるため、Macへ送信できません");
      return;
    }
    if (sendState === "success" && sentRecordingKeyRef.current === recordingUrl) {
      const resend = window.confirm("この録音は既にMacへ送信済みです。もう一度送信しますか？");
      if (!resend) return;
    }
    const consent = window.confirm(COMPANION_CONSENT_MESSAGE);
    if (!consent) return;

    setSendState("uploading");
    setSendError(null);
    try {
      const result = await uploadRecordingToCompanion(getCompanionBaseUrl(), companionToken, recordingBlobRef.current, {
        recordingId: generateRecordingId(),
        companyId: companyId ?? null,
        durationMs: elapsedMs,
      });
      setSendResult(result);
      setSendState("success");
      sentRecordingKeyRef.current = recordingUrl;
    } catch (error) {
      const message = companionErrorMessage(error);
      setSendError(message);
      setSendState("error");
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "unauthorized") {
        clearStoredToken();
        setCompanionToken(null);
      }
    }
  };

  const startTranscription = async () => {
    if (!companionToken || !recordingBlobRef.current) return;
    if (!isSameCompany(recordingCompanyIdRef.current, companyId)) {
      notify("表示中の企業が録音時と異なるため、文字起こしできません");
      return;
    }
    if (transcriptionState !== "idle" && transcriptionState !== "failed" && transcriptionState !== "cancelled" && transcriptionState !== "completed") return;

    const consent = window.confirm(COMPANION_CONSENT_MESSAGE);
    if (!consent) return;

    setTranscriptionText("");
    setTranscriptionModel(null);
    setTranscriptionDurationMs(null);
    setTranscriptionError(null);
    setTranscriptionCopied(false);
    setTranscriptionState("uploading");
    // 文字起こしを取り直す場合、古い文字起こしに基づく解析結果は無効になるため破棄する。
    resetAnalysisState();

    const controller = new AbortController();
    transcriptionAbortRef.current = controller;

    try {
      const jobId = await createTranscriptionJob(getCompanionBaseUrl(), companionToken, recordingBlobRef.current, {
        signal: controller.signal,
      });
      transcriptionJobIdRef.current = jobId;

      const finalJob = await pollTranscriptionJob(getCompanionBaseUrl(), companionToken, jobId, {
        signal: controller.signal,
        onUpdate: (job: TranscriptionJobView) => {
          if (job.status === "queued") { setTranscriptionState("uploading"); return; }
          if (job.status === "converting" || job.status === "transcribing") {
            setTranscriptionState(job.status);
          }
        },
      });

      if (finalJob.status === "completed") {
        setTranscriptionText(finalJob.text ?? "");
        setTranscriptionModel(finalJob.modelUsed);
        setTranscriptionDurationMs(finalJob.durationMs);
        setTranscriptionState("completed");
      } else if (finalJob.status === "cancelled") {
        setTranscriptionState("cancelled");
      } else {
        setTranscriptionError(finalJob.message ?? "文字起こしに失敗しました。");
        setTranscriptionState("failed");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = companionErrorMessage(error);
      setTranscriptionError(message);
      setTranscriptionState("failed");
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "unauthorized") {
        clearStoredToken();
        setCompanionToken(null);
      }
    } finally {
      transcriptionAbortRef.current = null;
    }
  };

  const cancelTranscription = async () => {
    const jobId = transcriptionJobIdRef.current;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    setTranscriptionState("cancelled");
    if (companionToken && jobId) {
      try {
        await cancelTranscriptionJob(getCompanionBaseUrl(), companionToken, jobId);
      } catch {
        // キャンセル要求自体が失敗しても、UI側は既にcancelled表示にしているため致命的ではない。
      }
    }
  };

  const copyTranscriptionText = async () => {
    try {
      await navigator.clipboard.writeText(transcriptionText);
      setTranscriptionCopied(true);
      setTimeout(() => setTranscriptionCopied(false), 2000);
    } catch {
      notify("コピーに失敗しました。手動で選択してコピーしてください。");
    }
  };

  // ---------------------------------------------------------
  // 営業通話解析（Phase 4、Codex連携）
  // ---------------------------------------------------------
  const startAnalysis = async () => {
    if (!companionToken || !transcriptionJobIdRef.current || transcriptionState !== "completed") return;
    if (!isSameCompany(recordingCompanyIdRef.current, companyId)) {
      notify("表示中の企業が録音・文字起こし時と異なるため、解析できません");
      return;
    }
    if (analysisState !== "idle" && analysisState !== "failed" && analysisState !== "cancelled" && analysisState !== "completed") return;

    const consent = window.confirm(ANALYSIS_CONSENT_MESSAGE);
    if (!consent) return;

    setAnalysisResult(null);
    setAnalysisError(null);
    setAnalysisApplyHeat(false);
    setAnalysisNextDate("");
    setAnalysisNextTime("");
    setAnalysisState("checking_auth");

    const controller = new AbortController();
    analysisAbortRef.current = controller;

    try {
      const jobId = await createAnalysisJob(
        getCompanionBaseUrl(),
        companionToken,
        transcriptionJobIdRef.current,
        companyId ?? "",
        { signal: controller.signal },
      );
      analysisJobIdRef.current = jobId;

      const finalJob = await pollAnalysisJob(getCompanionBaseUrl(), companionToken, jobId, {
        signal: controller.signal,
        onUpdate: (job: AnalysisJobView) => {
          if (job.status === "queued") { setAnalysisState("checking_auth"); return; }
          if (job.status === "checking_auth" || job.status === "starting_codex" || job.status === "analyzing" || job.status === "validating") {
            setAnalysisState(job.status);
          }
        },
      });

      if (finalJob.status === "completed" && finalJob.analysis) {
        setAnalysisResult(finalJob.analysis);
        const { date, time } = splitAnalysisDateTime(finalJob.analysis.next_action_at);
        setAnalysisNextDate(date);
        setAnalysisNextTime(time);
        setAnalysisState("completed");
      } else if (finalJob.status === "cancelled") {
        setAnalysisState("cancelled");
      } else {
        setAnalysisError(finalJob.message ?? "解析に失敗しました。");
        setAnalysisState("failed");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setAnalysisError(companionErrorMessage(error));
      setAnalysisState("failed");
    } finally {
      analysisAbortRef.current = null;
    }
  };

  const cancelAnalysis = async () => {
    const jobId = analysisJobIdRef.current;
    analysisAbortRef.current?.abort();
    analysisAbortRef.current = null;
    setAnalysisState("cancelled");
    if (companionToken && jobId) {
      try {
        await cancelAnalysisJob(getCompanionBaseUrl(), companionToken, jobId);
      } catch {
        // キャンセル要求自体が失敗しても、UI側は既にcancelled表示にしているため致命的ではない。
      }
    }
  };

  function updateAnalysisField<K extends keyof CallAnalysisResult>(key: K, value: CallAnalysisResult[K]) {
    setAnalysisResult((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  const applyAnalysisToForm = () => {
    if (!analysisResult) return;
    if (!isSameCompany(recordingCompanyIdRef.current, companyId)) {
      notify("表示中の企業が録音・解析時と異なるため、反映できません");
      return;
    }
    onApplyToForm?.({
      result: analysisResult.result,
      heat: analysisResult.heat,
      applyHeat: analysisApplyHeat,
      summary: analysisResult.summary,
      contactName: analysisResult.contact_name,
      challenges: analysisResult.challenges,
      nextAction: analysisResult.next_action,
      nextActionAt: analysisResult.next_action_at,
      transcript: transcriptionText,
    });
    notify("解析結果を架電フォームへ反映しました");
  };

  // ---------------------------------------------------------
  // 企業の取り違え防止：想定外に企業が変わった場合は安全のため強制破棄する
  // ---------------------------------------------------------
  const forceDiscardForSafety = useCallback(() => {
    stopEverything();
    setRecordingUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    recordingCompanyIdRef.current = null;
    setState("ready");
    resetCompanionSendState();
    resetTranscriptionState();
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
      transcriptionAbortRef.current?.abort();
      analysisAbortRef.current?.abort();
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

      {CALL_COMPANION_ENABLED && (
        <div className="mb-3 rounded-lg bg-white p-3">
          {!companionToken ? (
            <>
              <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold text-slate-500">
                <WifiOff size={12} className="text-slate-400" />Macの処理アプリ：未接続
              </p>
              <div className="flex gap-1.5">
                <button className="btn btn-light flex-1 !py-1.5 text-[10px]" disabled={companionChecking} onClick={checkCompanionConnection}>
                  {companionChecking ? "確認中…" : "接続を確認"}
                </button>
                <button className="btn btn-light flex-1 !py-1.5 text-[10px]" onClick={() => { setShowPairingForm((v) => !v); setPairingError(null); }}>
                  <KeyRound size={11} className="mr-1 inline" />ペアリングコードを入力
                </button>
              </div>
              {showPairingForm && (
                <div className="mt-2 flex gap-1.5">
                  <input
                    className="input flex-1 text-xs tracking-widest"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="123456"
                    value={pairingCodeInput}
                    onChange={(e) => setPairingCodeInput(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                  />
                  <button className="btn btn-primary !py-1.5 text-[10px]" disabled={pairingBusy} onClick={submitPairingCode}>
                    {pairingBusy ? "確認中…" : "ペアリングする"}
                  </button>
                </div>
              )}
              {pairingError && <p className="mt-1.5 text-[10px] text-red-600">{pairingError}</p>}
            </>
          ) : (
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-600">
                <Wifi size={12} />Macの処理アプリ：接続済み
              </p>
              <button className="text-[10px] font-bold text-slate-400 underline" onClick={unpairCompanion}>
                <Unplug size={11} className="mr-1 inline" />ペアリングを解除
              </button>
            </div>
          )}
        </div>
      )}

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
          <p className="mt-2 rounded bg-slate-50 p-2 text-[10px] text-slate-500">解析結果はご自身で確認・編集してから架電フォームへ反映してください（自動保存はされません）</p>
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

          {CALL_COMPANION_ENABLED && companionToken && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              {sendState === "idle" && (
                <button className="btn btn-light w-full text-xs" onClick={sendRecordingToCompanion}>
                  <Send size={12} className="mr-1 inline" />Macへ送信テスト
                </button>
              )}
              {sendState === "uploading" && (
                <div className="rounded-lg bg-slate-50 p-3 text-center text-xs font-bold text-slate-600">音声をMacへ送信しています…</div>
              )}
              {sendState === "success" && sendResult && (
                <div className="rounded-lg bg-emerald-50 p-3 text-[10px] leading-5 text-emerald-700">
                  <p className="font-bold">{sendResult.message}</p>
                  <p className="mt-1 text-slate-500">
                    形式 {sendResult.mimeType} ／ {formatFileSize(sendResult.sizeBytes)} ／ {formatElapsedTime(sendResult.durationMs)}
                    {sendResult.temporaryFileDeleted ? "／ 一時ファイル削除済み" : ""}
                  </p>
                  <button className="btn btn-light mt-2 w-full !py-1.5 text-[10px]" onClick={sendRecordingToCompanion}>
                    もう一度送信する
                  </button>
                </div>
              )}
              {sendState === "error" && (
                <div className="rounded-lg bg-red-50 p-3 text-[10px] text-red-600">
                  <p>{sendError}</p>
                  <button className="btn btn-light mt-2 w-full !py-1.5 text-[10px]" onClick={sendRecordingToCompanion}>
                    再送する
                  </button>
                </div>
              )}
            </div>
          )}

          {CALL_COMPANION_ENABLED && companionToken && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              {transcriptionState === "idle" && (
                <button className="btn btn-light w-full text-xs" onClick={startTranscription}>
                  <FileText size={12} className="mr-1 inline" />文字起こしを開始
                </button>
              )}
              {(transcriptionState === "uploading" || transcriptionState === "converting" || transcriptionState === "transcribing") && (
                <div className="rounded-lg bg-slate-50 p-3">
                  <p className="text-center text-xs font-bold text-slate-600">
                    {TRANSCRIPTION_PROGRESS_MESSAGES[transcriptionState]}…
                  </p>
                  <button className="btn btn-light mt-2 w-full !py-1.5 text-[10px]" onClick={cancelTranscription}>
                    <X size={11} className="mr-1 inline" />キャンセル
                  </button>
                </div>
              )}
              {transcriptionState === "completed" && (
                <div className="rounded-lg bg-white p-3">
                  <p className="mb-1.5 text-[10px] text-slate-500">
                    認識モデル: {transcriptionModel ?? "不明"}
                    {transcriptionDurationMs !== null && ` ／ 音声長 ${formatElapsedTime(transcriptionDurationMs)}`}
                  </p>
                  <textarea
                    className="input min-h-[100px] w-full text-xs leading-5"
                    value={transcriptionText}
                    onChange={(e) => setTranscriptionText(e.target.value)}
                  />
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    <button className="btn btn-light !py-1.5 text-[10px]" onClick={copyTranscriptionText}>
                      <Copy size={12} className="mr-1 inline" />{transcriptionCopied ? "コピー済み" : "コピー"}
                    </button>
                    <button className="btn btn-light !py-1.5 text-[10px]" onClick={startTranscription}>
                      <FileText size={12} className="mr-1 inline" />再実行
                    </button>
                    <button className="btn btn-light !py-1.5 text-[10px] text-red-600" onClick={resetTranscriptionState}>
                      <Trash2 size={12} className="mr-1 inline" />破棄
                    </button>
                  </div>
                </div>
              )}
              {transcriptionState === "cancelled" && (
                <div className="rounded-lg bg-slate-50 p-3 text-[10px] text-slate-500">
                  <p>文字起こしをキャンセルしました。</p>
                  <button className="btn btn-light mt-2 w-full !py-1.5 text-[10px]" onClick={startTranscription}>
                    もう一度実行する
                  </button>
                </div>
              )}
              {transcriptionState === "failed" && (
                <div className="rounded-lg bg-red-50 p-3 text-[10px] text-red-600">
                  <p>{transcriptionError}</p>
                  <button className="btn btn-light mt-2 w-full !py-1.5 text-[10px]" onClick={startTranscription}>
                    再試行する
                  </button>
                </div>
              )}
            </div>
          )}

          {CALL_ANALYSIS_ENABLED && companionToken && transcriptionState === "completed" && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              {analysisState === "idle" && (
                <button className="btn btn-ai w-full text-xs" onClick={startAnalysis}>
                  <Sparkles size={12} className="mr-1 inline" />Codexで営業内容を解析
                </button>
              )}
              {(analysisState === "checking_auth" || analysisState === "starting_codex" || analysisState === "analyzing" || analysisState === "validating") && (
                <div className="rounded-lg bg-slate-50 p-3">
                  <p className="text-center text-xs font-bold text-slate-600">{ANALYSIS_PROGRESS_MESSAGES[analysisState]}…</p>
                  <button className="btn btn-light mt-2 w-full !py-1.5 text-[10px]" onClick={cancelAnalysis}>
                    <X size={11} className="mr-1 inline" />キャンセル
                  </button>
                </div>
              )}
              {analysisState === "completed" && analysisResult && (
                <div className="rounded-lg bg-white p-3">
                  {(analysisResult.needs_review || analysisResult.confidence < 0.6) && (
                    <p className="mb-2 flex items-start gap-1.5 rounded-lg bg-amber-50 p-2 text-[10px] leading-5 text-amber-700">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                      <span>
                        内容の確認をおすすめします（解析信頼度 {Math.round(analysisResult.confidence * 100)}%）
                        {analysisResult.review_reasons.length > 0 && `：${analysisResult.review_reasons.join("／")}`}
                      </span>
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="mb-1 block text-[9px] font-bold text-slate-500">架電結果</span>
                      <select
                        className="input !py-1.5 text-[11px]"
                        value={analysisResult.result}
                        onChange={(e) => updateAnalysisField("result", e.target.value)}
                      >
                        {ANALYSIS_RESULT_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[9px] font-bold text-slate-500">温度感</span>
                      <select
                        className="input !py-1.5 text-[11px]"
                        value={analysisResult.heat}
                        onChange={(e) => updateAnalysisField("heat", e.target.value)}
                      >
                        {ANALYSIS_HEAT_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-500">
                    <input type="checkbox" checked={analysisApplyHeat} onChange={(e) => setAnalysisApplyHeat(e.target.checked)} />
                    この温度感（{analysisResult.heat}）を企業情報に適用する
                  </label>
                  <label className="mt-2 block">
                    <span className="mb-1 block text-[9px] font-bold text-slate-500">要約</span>
                    <textarea
                      className="input min-h-[70px] w-full text-[11px] leading-5"
                      value={analysisResult.summary}
                      onChange={(e) => updateAnalysisField("summary", e.target.value)}
                    />
                  </label>
                  <label className="mt-2 block">
                    <span className="mb-1 block text-[9px] font-bold text-slate-500">相手の課題（1行に1つ）</span>
                    <textarea
                      className="input min-h-[50px] w-full text-[11px] leading-5"
                      value={analysisResult.challenges.join("\n")}
                      onChange={(e) => updateAnalysisField("challenges", e.target.value.split("\n").filter((s) => s.trim()))}
                    />
                  </label>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="mb-1 block text-[9px] font-bold text-slate-500">検出した担当者（参考、自動保存されません）</span>
                      <input
                        className="input !py-1.5 text-[11px]"
                        value={analysisResult.contact_name ?? ""}
                        placeholder="検出できず"
                        onChange={(e) => updateAnalysisField("contact_name", e.target.value || null)}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[9px] font-bold text-slate-500">次回対応日</span>
                      <div className="flex gap-1">
                        <input
                          type="date"
                          className="input !py-1.5 text-[11px]"
                          value={analysisNextDate}
                          onChange={(e) => {
                            const nextDate = e.target.value;
                            const nextTime = nextDate ? analysisNextTime : "";
                            setAnalysisNextDate(nextDate);
                            if (!nextDate) setAnalysisNextTime("");
                            updateAnalysisField("next_action_at", combineDateTime(nextDate, nextTime));
                          }}
                        />
                        <input
                          type="time"
                          className="input !py-1.5 text-[11px]"
                          value={analysisNextTime}
                          onChange={(e) => {
                            setAnalysisNextTime(e.target.value);
                            updateAnalysisField("next_action_at", combineDateTime(analysisNextDate, e.target.value));
                          }}
                        />
                      </div>
                    </label>
                  </div>
                  <label className="mt-2 block">
                    <span className="mb-1 block text-[9px] font-bold text-slate-500">次回対応</span>
                    <textarea
                      className="input min-h-[50px] w-full text-[11px] leading-5"
                      value={analysisResult.next_action}
                      onChange={(e) => updateAnalysisField("next_action", e.target.value)}
                    />
                  </label>
                  <div className="mt-3 grid grid-cols-3 gap-1.5">
                    <button className="btn btn-primary col-span-1 !py-1.5 text-[10px]" onClick={applyAnalysisToForm}>
                      <ArrowRightCircle size={12} className="mr-1 inline" />架電フォームへ反映
                    </button>
                    <button className="btn btn-light !py-1.5 text-[10px]" onClick={startAnalysis}>
                      <Sparkles size={12} className="mr-1 inline" />再実行
                    </button>
                    <button className="btn btn-light !py-1.5 text-[10px] text-red-600" onClick={resetAnalysisState}>
                      <Trash2 size={12} className="mr-1 inline" />破棄
                    </button>
                  </div>
                </div>
              )}
              {analysisState === "cancelled" && (
                <div className="rounded-lg bg-slate-50 p-3 text-[10px] text-slate-500">
                  <p>解析をキャンセルしました。</p>
                  <button className="btn btn-light mt-2 w-full !py-1.5 text-[10px]" onClick={startAnalysis}>
                    もう一度実行する
                  </button>
                </div>
              )}
              {analysisState === "failed" && (
                <div className="rounded-lg bg-red-50 p-3 text-[10px] text-red-600">
                  <p>{analysisError}</p>
                  <button className="btn btn-light mt-2 w-full !py-1.5 text-[10px]" onClick={startAnalysis}>
                    再試行する
                  </button>
                </div>
              )}
            </div>
          )}
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
