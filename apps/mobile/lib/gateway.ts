import type { RoomCreateRequest, RoomCreateResponse } from "@syncstream/types";

// 10.0.2.2 is the Android emulator's alias for the host machine's localhost.
// Physical devices must set EXPO_PUBLIC_GATEWAY_URL to the host's LAN IP
// (e.g. http://192.168.1.23:4003) since 10.0.2.2 only resolves inside the
// emulator's virtual network.
export const GATEWAY_URL = process.env.EXPO_PUBLIC_GATEWAY_URL ?? "http://10.0.2.2:4003";

export class GatewayRequestError extends Error {}

export async function createRoom(request: RoomCreateRequest): Promise<RoomCreateResponse> {
  const res = await fetch(`${GATEWAY_URL}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const problem = await res.json().catch(() => null);
    throw new GatewayRequestError(problem?.detail ?? `Failed to create room (${res.status}).`);
  }

  return res.json();
}
