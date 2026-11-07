export const DEFAULT_PROMPT_CLOUD_TIMEOUT_SECONDS = 600;
export const MIN_PROMPT_CLOUD_TIMEOUT_SECONDS = 30;
export const MAX_PROMPT_CLOUD_TIMEOUT_SECONDS = 1800;

/**
 * Prompt-only cloud request timeout, in seconds. Accept finite integers in the
 * inclusive supported range. Missing, non-numeric, fractional, and out-of-range
 * values (including old/imported configuration) use the default; never coerce or
 * clamp invalid values. Agent chat and local-model timeouts are independent.
 */
export function normalizePromptCloudTimeoutSeconds(value: unknown): number {
    return typeof value === "number"
        && Number.isInteger(value)
        && value >= MIN_PROMPT_CLOUD_TIMEOUT_SECONDS
        && value <= MAX_PROMPT_CLOUD_TIMEOUT_SECONDS
        ? value
        : DEFAULT_PROMPT_CLOUD_TIMEOUT_SECONDS;
}
