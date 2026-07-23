type VrcDesktopUpdateStage = "idle" | "checking" | "unavailable" | "up-to-date" | "available" | "downloading" | "ready" | "error";

interface VrcDesktopUpdateState {
  stage: VrcDesktopUpdateStage;
  currentVersion: string;
  availableVersion: string;
  progress: number;
  transferred: number;
  total: number;
  releaseNotes: string;
  message: string;
  checkedAt: string;
  supported: boolean;
  distribution: "installed" | "portable" | "unsupported";
  platform: string;
}

interface VrcDesktopUpdateApi {
  getState(): Promise<VrcDesktopUpdateState>;
  check(): Promise<VrcDesktopUpdateState>;
  download(): Promise<VrcDesktopUpdateState>;
  install(): Promise<{ accepted: boolean }>;
  onState(listener: (state: VrcDesktopUpdateState) => void): () => void;
}

interface Window {
  vrcDesktopUpdate?: VrcDesktopUpdateApi;
}
