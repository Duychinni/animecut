export type PipelineErrorInfo = {
  code: 'youtube_source_blocked' | 'not_enough_content' | 'worker_stale' | 'pipeline_paused';
  title: string;
  message: string;
  stageLabel: string;
  tone: 'amber' | 'red';
};

function toErrorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return 'Processing paused';
    }
  }
  return 'Processing paused';
}

export function isYouTubeSourceBlocked(error: unknown) {
  const text = toErrorText(error).toLowerCase();
  return (
    text.includes('youtube blocked this link') ||
    text.includes('sign in to confirm') ||
    text.includes('not a bot') ||
    text.includes('--cookies-from-browser') ||
    text.includes('cookies for the authentication') ||
    text.includes('no title found in player responses')
  );
}

export function getPipelineErrorInfo(error: unknown): PipelineErrorInfo {
  const text = toErrorText(error);

  if (text === 'not_enough_content') {
    return {
      code: 'not_enough_content',
      title: 'No valid clips found',
      message: 'This video did not have enough complete standalone moments to make strong reels.',
      stageLabel: 'No valid clips found',
      tone: 'amber',
    };
  }

  if (isYouTubeSourceBlocked(text)) {
    return {
      code: 'youtube_source_blocked',
      title: 'Upload the video file to continue',
      message: 'YouTube blocked this link before AnimaCut could read the source. Upload the video file instead, or try another public link.',
      stageLabel: 'Source blocked by YouTube',
      tone: 'amber',
    };
  }

  if (text.toLowerCase().includes('heartbeat expired')) {
    return {
      code: 'worker_stale',
      title: 'Processing paused',
      message: 'The worker stopped sending progress. The app can safely retry this run.',
      stageLabel: 'Processing paused',
      tone: 'amber',
    };
  }

  return {
    code: 'pipeline_paused',
    title: 'Processing paused',
    message: 'Something interrupted this run. Try again, or upload the video file if the link keeps getting blocked.',
    stageLabel: 'Processing paused',
    tone: 'red',
  };
}

export function getPublicPipelineError(error: unknown) {
  return getPipelineErrorInfo(error).message;
}
