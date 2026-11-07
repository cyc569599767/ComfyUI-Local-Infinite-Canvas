export const DEFAULT_LOCAL_PROMPT_TIMEOUT_SECONDS = 600;
export const MIN_LOCAL_PROMPT_TIMEOUT_SECONDS = 30;
export const MAX_LOCAL_PROMPT_TIMEOUT_SECONDS = 1800;

/**
 * Shared local prompt timeout, in seconds. Only integers in the inclusive range
 * are valid; missing, non-number, fractional and out-of-range values fall back
 * to the default without coercion or clamping. Cloud API timeouts are separate.
 */
export function normalizeLocalPromptTimeoutSeconds(value: unknown): number {
    return typeof value === "number"
        && Number.isInteger(value)
        && value >= MIN_LOCAL_PROMPT_TIMEOUT_SECONDS
        && value <= MAX_LOCAL_PROMPT_TIMEOUT_SECONDS
        ? value
        : DEFAULT_LOCAL_PROMPT_TIMEOUT_SECONDS;
}
