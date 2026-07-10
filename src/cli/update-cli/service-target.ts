import { resolveGatewayService } from "../../daemon/service.js";

export type UpdateGatewayServiceTarget = {
  scope: "system" | "platform";
  service: ReturnType<typeof resolveGatewayService>;
};

export async function resolveUpdateGatewayServiceTarget(): Promise<UpdateGatewayServiceTarget> {
  const service = resolveGatewayService();
  return {
    scope: service.label === "systemd system service" ? "system" : "platform",
    service,
  };
}
