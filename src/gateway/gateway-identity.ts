import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";

export type PublicGatewayIdentity = {
  deviceId: string;
  publicKey: string;
};

export function getPublicGatewayIdentity(): PublicGatewayIdentity {
  const identity = loadOrCreateDeviceIdentity();
  return {
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
  };
}
