// Generated from finalized SAT-DEP-0009 deployment evidence; do not edit.

export const SAT_VNEXT_ACTIVATION = {
  $schema: "fased.sat-vnext-activation.v1",
  state: "FROZEN_NOT_ACTIVE",
  deploymentId: "SAT-DEP-0009",
  cluster: "devnet",
  interfaceContractSha256:
    "sha256:74439f2033b857df0d408830fa5df1406a1c2cb5245f242bb89bdc756a960274", // pragma: allowlist secret
  programs: {
    mining: {
      programId: "H79sGVMLFSHX14rAj7gBxNS31V1984Br3d6PZKP4jNhF", // pragma: allowlist secret
      programDataAddress: "3bzGnmBnDhsB2ct3HUVBazrMNpbheizosEZ7H2evjoQu", // pragma: allowlist secret
      deploymentSlot: 489993547,
      allocatedImageSha256:
        "sha256:033ae4011c1ae153d364fa25bf7839aaafd62824669b7101cd3c058ecf1bceed", // pragma: allowlist secret
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
    accountSha256: "sha256:14592556f27a42e66b8f3e1616e84df66d0521f8bf2e8b243739e1a90e2ed738", // pragma: allowlist secret
    publicEntryEnabled: false,
    activationGeneration: 5,
    componentTupleHex: "0100020002000300030003000300020002000200", // pragma: allowlist secret
    economicsContractSha256:
      "sha256:ec935a84a00d6bd8269b856b84328684e3d977a5f0fb758fd3884cd310a6934c", // pragma: allowlist secret
  },
  activation: {
    signature:
      "h4MM1BCSWp3qLwJCRSVWDhJzBFAye7h5CytJGrMEGPgJaUduH4Bi2ShdfeGvh5LUjbRWnK7Ut9C3Sozssg6ArCM", // pragma: allowlist secret
    finalizedSlot: 489778039,
    receiptDigest: "sha256:b306d2edcd6e1c3b6946383aedea11eaad0d6ad7db7162fe156813a3bf31a61b", // pragma: allowlist secret
  },
  replacementDeployment: {
    signature:
      "5Tg6DtHBXCnSoEoMzzDzzTCs3hXtSgDqgcrxtb3A25Q6uVNraHQfcSVv9TRpfm55nk3sYFtKauRAe6PKkUZgaTj5", // pragma: allowlist secret
    finalizedSlot: 489993547,
    descriptorSha256: "sha256:d8178a88027538d4a6e910e5fdbab8e07694216504e21b46bdde331f228386bb", // pragma: allowlist secret
    artifactSha256: "sha256:7225cc7b242b82385e4cff036e14b98369900d9b797fb063c12055c2550e6a43", // pragma: allowlist secret
    artifactBytes: 754832,
    allocatedImageSha256: "sha256:033ae4011c1ae153d364fa25bf7839aaafd62824669b7101cd3c058ecf1bceed", // pragma: allowlist secret
    allocatedImageBytes: 764176,
    zeroPaddingBytes: 9344,
  },
} as const;
