// Generated from finalized SAT-DEP-0008 deployment evidence; do not edit.

export const SAT_VNEXT_ACTIVATION = {
  $schema: "fased.sat-vnext-activation.v1",
  state: "FROZEN_NOT_ACTIVE",
  deploymentId: "SAT-DEP-0008",
  cluster: "devnet",
  interfaceContractSha256:
    "sha256:2232dcb4d977d582ee0d1593d8a0886e620151581b49ebc24f43dbf91a7bbc15", // pragma: allowlist secret
  programs: {
    mining: {
      programId: "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF", // pragma: allowlist secret
      programDataAddress: "3bzGnmBnDhsB2ct3HUVBazrMNpbheizosEZ7H2evjoQu", // pragma: allowlist secret
      deploymentSlot: 489703957,
      allocatedImageSha256:
        "sha256:d63a61af908842530c9786784cabb8f55db08ac5d71b23ac3597a4701b704257", // pragma: allowlist secret
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
    accountSha256: "sha256:935837ae7e52b5c8ee826851d6445fe5f858160eec061a39b410ff63a5639ab9", // pragma: allowlist secret
    publicEntryEnabled: false,
    activationGeneration: 3,
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
  replacementDeployment: {
    signature:
      "9JLKNB5CEYNmJQRzCjwZBKx9wSuAJvJwa6LH2KC2cpbZrzFmLsXSTNeZ2sRP9wo3GscxWRzzJdfg3mpfnh2qQcK", // pragma: allowlist secret
    finalizedSlot: 489703957,
    descriptorSha256: "sha256:6d92f2b93a273e4bd1c8daa6fc9e45681964e11850b99307b5e5998388909569", // pragma: allowlist secret
    artifactSha256: "sha256:399a627e5ad851308757a1077b2f2223d5b30853e75e36eb964b3d5d5a52047e", // pragma: allowlist secret
    artifactBytes: 754408,
    allocatedImageSha256: "sha256:d63a61af908842530c9786784cabb8f55db08ac5d71b23ac3597a4701b704257", // pragma: allowlist secret
    allocatedImageBytes: 764176,
    zeroPaddingBytes: 9768,
  },
} as const;
