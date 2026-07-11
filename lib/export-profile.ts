export const DEFAULT_VERTICAL_EXPORT_WIDTH = 1080;
export const DEFAULT_VERTICAL_EXPORT_HEIGHT = 1920;

function even(value: number) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function readEvenEnv(name: string, fallback: number) {
  const raw = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(raw) || raw < 360) return fallback;
  return even(raw);
}

export function getVerticalExportSize() {
  const height = readEvenEnv('VERTICAL_EXPORT_HEIGHT', DEFAULT_VERTICAL_EXPORT_HEIGHT);
  const widthFromEnv = process.env.VERTICAL_EXPORT_WIDTH
    ? readEvenEnv('VERTICAL_EXPORT_WIDTH', DEFAULT_VERTICAL_EXPORT_WIDTH)
    : even((height * 9) / 16);

  return {
    width: widthFromEnv,
    height,
  };
}
