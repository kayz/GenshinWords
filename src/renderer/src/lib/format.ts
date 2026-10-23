export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function localDate(value: string | number): string {
  return new Date(value).toLocaleString('zh-CN', {
    hour12: false,
  });
}
