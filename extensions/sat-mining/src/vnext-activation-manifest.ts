// Generated from finalized SAT-DEP-0006 activation evidence; do not edit.

export const SAT_VNEXT_ACTIVATION = {
  $schema: "fased.sat-vnext-activation.v1",
  state: "ACTIVE",
  deploymentId: "SAT-DEP-0006",
  cluster: "devnet",
  interfaceContractSha256:
    "sha256:dd562e2f98671d737e9698ad0faec5d2d1154d43d1e3354607f782133a668586", // pragma: allowlist secret
  programs: {
    mining: {
      programId: "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF", // pragma: allowlist secret
      programDataAddress: "3bzGnmBnDhsB2ct3HUVBazrMNpbheizosEZ7H2evjoQu", // pragma: allowlist secret
      deploymentSlot: 489112180,
      allocatedImageSha256:
        "sha256:b5492663b27796b789d0c801efb35268e36b970154179472cce746a50855f9af", // pragma: allowlist secret
    },
    mint: {
      programId: "71Med1feR4RvP9crdNYtAdMB2YQmSmkbyZhKYRzcRJKL", // pragma: allowlist secret
      programDataAddress: "HwJ6bGHF6iK9adY2eMTHHyqEEoFtU1oxRF2GypFpUQ8E", // pragma: allowlist secret
      deploymentSlot: 488411168,
      allocatedImageSha256:
        "sha256:c82b8a5e5f83bb451f6a714840db193d68242928633606e12bced83a66d44a45", // pragma: allowlist secret
    },
    bond: {
      programId: "5peszKe8y7dv8KqdSse9UFxmaLxGsy7pWJBm6KpGnGA3", // pragma: allowlist secret
      programDataAddress: "HDRZP9bxzmhCcAAtkjL9giJ6zmY1pXjeTfb6zo9aXznw", // pragma: allowlist secret
      deploymentSlot: 489112812,
      allocatedImageSha256:
        "sha256:ce67a62d347c30ef988c1db40a78b3248823e8b2222875b72812200cf25bf6aa", // pragma: allowlist secret
    },
  },
  satMint: "BbZ7cUmbD9s43jeqK65Jjg8QWo5VNMZovKURVEYx4DqU", // pragma: allowlist secret
  protocolGenerationState: {
    address: "4bAddyonLtrQmAKfASHgpUHqaxYY7fU48yrXV7JJrBzE", // pragma: allowlist secret
    accountSha256: "sha256:dee155fd9de4ccda8fe0a7296f3256863bef09d1d623428706b52d9d003fc8c6", // pragma: allowlist secret
    publicEntryEnabled: true,
    activationGeneration: 2,
    componentTupleHex: "0100020002000300030003000300020002000200", // pragma: allowlist secret
    economicsContractSha256:
      "sha256:ec935a84a00d6bd8269b856b84328684e3d977a5f0fb758fd3884cd310a6934c", // pragma: allowlist secret
  },
  activation: {
    signature:
      "3k4H9r33xRyo3yvtVMi3bi7JSa5gqnQPCLMThXAXLpqtLnPJHQZWHvJd1x2sxDbLmppDZEzYz3MBCSn1WCzPAq8E", // pragma: allowlist secret
    finalizedSlot: 489132439,
    receiptDigest: "sha256:546af09f8e8fb0c263745a31b13fe2985c0150941af10be015f7b6e8496ea896", // pragma: allowlist secret
  },
} as const;
