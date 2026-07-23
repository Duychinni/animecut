export type SourceColorMetadata = {
  colorSpace?: string | null;
  colorTransfer?: string | null;
  colorPrimaries?: string | null;
};

export type RenderOutputArgsOptions = {
  encoder: string;
  preset: string;
  crf: string;
  x264Maxrate: string;
  x264Bufsize: string;
  hardwareBitrate: string;
  hardwareMaxrate: string;
  hardwareBufsize: string;
  volume: number;
  outputPath: string;
  outputFps?: number | null;
  sourceColor?: SourceColorMetadata | null;
};

const BT709_ALIASES = new Set(['bt709', 'bt709nc']);
const DEFAULT_EXPORT_STORAGE_BUDGET_BYTES = 44 * 1024 * 1024;

export function resolveStorageSafeVideoRates(
  durationSeconds: number,
  maxVideoKbps = 10_000,
  storageBudgetBytes = DEFAULT_EXPORT_STORAGE_BUDGET_BYTES,
) {
  const duration = Math.max(1, Number(durationSeconds) || 1);
  const audioAndContainerKbps = 256;
  const budgetKbps = Math.floor((storageBudgetBytes * 8) / duration / 1000) - audioAndContainerKbps;
  const bitrateKbps = Math.max(1_800, Math.min(maxVideoKbps, budgetKbps));
  const maxrateKbps = Math.max(bitrateKbps, Math.min(maxVideoKbps, Math.round(bitrateKbps * 1.12)));
  const bufsizeKbps = maxrateKbps * 2;

  return {
    bitrate: `${bitrateKbps}k`,
    maxrate: `${maxrateKbps}k`,
    bufsize: `${bufsizeKbps}k`,
  };
}

export function buildSourceAwareColorArgs(sourceColor?: SourceColorMetadata | null) {
  if (!sourceColor) return [];
  const colorSpace = sourceColor.colorSpace?.toLowerCase();
  const colorTransfer = sourceColor.colorTransfer?.toLowerCase();
  const colorPrimaries = sourceColor.colorPrimaries?.toLowerCase();

  // Metadata flags describe encoded pixels; they do not convert them. Preserve
  // an explicitly probed BT.709 source only. HDR/wide-gamut inputs need actual
  // tone mapping before they can safely be labelled BT.709.
  if (!colorSpace || !BT709_ALIASES.has(colorSpace) || colorTransfer !== 'bt709' || colorPrimaries !== 'bt709') {
    return [];
  }

  return [
    '-colorspace', 'bt709',
    '-color_trc', 'bt709',
    '-color_primaries', 'bt709',
  ];
}

export function buildRenderOutputArgs(options: RenderOutputArgsOptions) {
  const args: string[] = ['-c:v', options.encoder];
  const outputFps = Number(options.outputFps ?? 0);
  if (Number.isFinite(outputFps) && outputFps >= 24 && outputFps <= 60) {
    args.push('-r', String(Math.round(outputFps)));
  }

  if (options.encoder === 'libx264') {
    args.push(
      '-preset', options.preset,
      '-crf', options.crf,
      '-maxrate', options.x264Maxrate,
      '-bufsize', options.x264Bufsize,
      '-profile:v', 'high',
      '-level', '4.2',
      '-g', '30',
      '-keyint_min', '15',
      '-sc_threshold', '0',
      '-threads', '0',
    );
  } else {
    args.push(
      '-b:v', options.hardwareBitrate,
      '-maxrate', options.hardwareMaxrate,
      '-bufsize', options.hardwareBufsize,
      '-g', '30',
    );
    if (options.encoder === 'h264_videotoolbox') {
      args.push('-profile:v', 'high', '-realtime', '0');
    }
  }

  args.push(
    '-pix_fmt', 'yuv420p',
    ...buildSourceAwareColorArgs(options.sourceColor),
    '-af', `volume=${Math.max(0, Math.min(2, options.volume))}`,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    options.outputPath,
  );
  return args;
}
