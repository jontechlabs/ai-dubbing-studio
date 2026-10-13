import { useEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
export function PlaybackMetrics({ videoRef }: { videoRef: RefObject<HTMLVideoElement | null> }) {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState({ width: 0, height: 0, dropped: 0, total: 0 });
  useEffect(() => {
    const read = () => {
      const video = videoRef.current;
      if (!video) return;
      const quality = video.getVideoPlaybackQuality?.();
      setMetrics({
        width: video.videoWidth,
        height: video.videoHeight,
        dropped: quality?.droppedVideoFrames ?? 0,
        total: quality?.totalVideoFrames ?? 0,
      });
    };
    read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, [videoRef]);
  return (
    <div className="settings-section">
      <h3>{t('previewPerformance')}</h3>
      <p>{t('playbackResolution', { width: metrics.width, height: metrics.height })}</p>
      <p>{t('playbackFrames', { dropped: metrics.dropped, total: metrics.total })}</p>
      <p className="panel-description">{t('playbackMetricsHint')}</p>
    </div>
  );
}
