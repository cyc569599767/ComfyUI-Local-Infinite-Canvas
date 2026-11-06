/**
 * The browser build often serves canvas and gateway on the same origin. Electron
 * gives them separate loopback ports, so resolve gateway-relative generated
 * files (3D model, preview, depth map) against the configured local gateway.
 */
export function resolveGatewayAssetUrl(value: string | undefined, gatewayBase: string): string | undefined {
    if (!value) return value;
    try {
        const gateway = new URL(String(gatewayBase || "").trim());
        const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(gateway.hostname);
        if (gateway.protocol !== "http:" || !loopback || gateway.username || gateway.password) return value;
        const resolved = new URL(value, `${gateway.origin}/`);
        return resolved.origin === gateway.origin ? resolved.toString() : value;
    } catch {
        return value;
    }
}
