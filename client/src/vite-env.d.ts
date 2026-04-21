/// <reference types="vite/client" />

interface YouTubePlayerInstance {
  cueVideoById(options: { videoId: string; startSeconds?: number }): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  getCurrentTime(): number;
}

interface Window {
  YT?: {
    Player: new (
      elementId: string,
      options: {
        videoId: string;
        playerVars?: Record<string, unknown>;
        events?: {
          onReady?: () => void;
          onStateChange?: (event: { data: number }) => void;
        };
      },
    ) => YouTubePlayerInstance;
    PlayerState: {
      PLAYING: number;
      PAUSED: number;
      ENDED: number;
    };
  };
  onYouTubeIframeAPIReady?: () => void;
}
