import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { resolveGatewayAssetUrl as resolve } from "@/lib/gateway-asset-url";

export function resolveGatewayAssetUrl(value: string | undefined, gatewayBase = LOCAL_GATEWAY_BASE_URL): string | undefined {
    return resolve(value, gatewayBase);
}
