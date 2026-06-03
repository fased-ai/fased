export type MarketplaceServiceKindOption = {
  value: string;
  label: string;
  description: string;
  inputShape: string;
  deliveryShape: string;
  capabilities: string[];
  aliases: string[];
};

export type MarketplaceServiceKindGroup = {
  label: string;
  options: readonly MarketplaceServiceKindOption[];
};

export const MARKETPLACE_SERVICE_KIND_GROUPS: readonly MarketplaceServiceKindGroup[] = [
  {
    label: "General",
    options: [
      {
        value: "task.general",
        label: "General task",
        description: "Small text or structured work that does not fit a narrower offer type.",
        inputShape: "task-request",
        deliveryShape: "text-result",
        capabilities: ["chat", "task-execution"],
        aliases: ["general", "task", "misc", "custom"],
      },
      {
        value: "freelancer.service",
        label: "Freelancer service",
        description: "Human or agent-assisted professional service with scoped deliverables.",
        inputShape: "brief",
        deliveryShape: "deliverable-package",
        capabilities: ["service", "quote", "delivery"],
        aliases: ["freelance", "gig", "consulting", "service"],
      },
      {
        value: "human.task",
        label: "Human task",
        description: "Manual seller work delivered after payment; no automatic task run.",
        inputShape: "task-brief",
        deliveryShape: "manual-deliverable",
        capabilities: ["manual-service", "human", "delivery"],
        aliases: ["human", "manual", "manual task", "operator", "freelancer"],
      },
      {
        value: "support.triage",
        label: "Support triage",
        description: "Classify, prioritize, and route support requests or incidents.",
        inputShape: "support-ticket",
        deliveryShape: "triage-report",
        capabilities: ["support", "classification", "routing"],
        aliases: ["support", "ticket", "triage", "helpdesk"],
      },
    ],
  },
  {
    label: "Content",
    options: [
      {
        value: "content.summarize",
        label: "Content summary",
        description: "Summarize source text, URLs, notes, calls, or documents.",
        inputShape: "source-text",
        deliveryShape: "summary-v0",
        capabilities: ["summarize", "text"],
        aliases: ["summarize", "summary", "recap", "notes"],
      },
      {
        value: "content.create",
        label: "Content creation",
        description: "Create posts, docs, copy, scripts, newsletters, or landing-page text.",
        inputShape: "creative-brief",
        deliveryShape: "content-draft",
        capabilities: ["writing", "copy", "editing"],
        aliases: ["write", "copy", "blog", "newsletter", "post", "script"],
      },
      {
        value: "translation.localize",
        label: "Translation/localization",
        description: "Translate or localize text for a target language, region, or audience.",
        inputShape: "source-text",
        deliveryShape: "localized-text",
        capabilities: ["translation", "localization"],
        aliases: ["translate", "translation", "localize", "localization"],
      },
      {
        value: "media.generate",
        label: "Media generation",
        description: "Generate or transform images, clips, audio, thumbnails, or creative assets.",
        inputShape: "media-brief",
        deliveryShape: "media-artifacts",
        capabilities: ["image", "video", "audio", "creative"],
        aliases: ["image", "video", "audio", "media", "creative asset", "thumbnail"],
      },
      {
        value: "design.creative",
        label: "Design/creative",
        description: "Design brand, product, UI, ad, deck, or campaign assets.",
        inputShape: "design-brief",
        deliveryShape: "design-package",
        capabilities: ["design", "creative", "layout"],
        aliases: ["design", "brand", "ui", "deck", "creative"],
      },
    ],
  },
  {
    label: "Data/API",
    options: [
      {
        value: "data.lookup",
        label: "Data lookup",
        description: "Look up facts, records, inventory, prices, addresses, or public data.",
        inputShape: "lookup-query",
        deliveryShape: "lookup-result",
        capabilities: ["lookup", "data", "verification"],
        aliases: ["lookup", "find data", "record", "inventory", "price check"],
      },
      {
        value: "data.extract",
        label: "Data extraction",
        description: "Extract structured fields from documents, messages, pages, or files.",
        inputShape: "documents-or-text",
        deliveryShape: "structured-data",
        capabilities: ["extract", "parse", "schema"],
        aliases: ["extract", "parse", "scrape", "table", "csv"],
      },
      {
        value: "data.enrich",
        label: "Data enrichment",
        description: "Clean, dedupe, classify, append, or enrich records and leads.",
        inputShape: "records",
        deliveryShape: "enriched-records",
        capabilities: ["enrichment", "classification", "dedupe"],
        aliases: ["enrich", "clean", "dedupe", "classify", "leads"],
      },
      {
        value: "api.access",
        label: "API access",
        description: "Metered or quoted access to a hosted API, database, model, or tool.",
        inputShape: "api-request",
        deliveryShape: "api-response",
        capabilities: ["api", "metering", "integration"],
        aliases: ["api", "endpoint", "webhook", "database", "model access"],
      },
      {
        value: "api.proxy",
        label: "API proxy",
        description: "Proxy, transform, rate-limit, or broker requests to another API or system.",
        inputShape: "proxy-request",
        deliveryShape: "proxied-response",
        capabilities: ["proxy", "transform", "rate-limit"],
        aliases: ["proxy", "broker", "transform api", "rate limit"],
      },
      {
        value: "data.feed",
        label: "Data feed",
        description: "Subscription-style feed delivery for data updates, events, or records.",
        inputShape: "feed-request",
        deliveryShape: "feed-events",
        capabilities: ["feed", "subscription", "webhook", "data"],
        aliases: ["feed", "data feed", "subscription feed", "events", "stream"],
      },
      {
        value: "data.labeling",
        label: "Data labeling",
        description: "Label, classify, annotate, or review datasets for training and QA.",
        inputShape: "dataset",
        deliveryShape: "labeled-dataset",
        capabilities: ["labeling", "annotation", "qa"],
        aliases: ["label", "annotation", "dataset", "training data"],
      },
    ],
  },
  {
    label: "Automation",
    options: [
      {
        value: "automation.task",
        label: "Automation task",
        description: "Run a bounded automated task with explicit inputs and completion rules.",
        inputShape: "automation-request",
        deliveryShape: "automation-result",
        capabilities: ["automation", "task-runner"],
        aliases: ["automation", "automate", "scheduled task", "run task"],
      },
      {
        value: "automation.workflow",
        label: "Workflow",
        description: "Run a multi-step workflow across tools, channels, files, or APIs.",
        inputShape: "workflow-brief",
        deliveryShape: "workflow-report",
        capabilities: ["workflow", "orchestration", "automation"],
        aliases: ["workflow", "orchestration", "zap", "pipeline"],
      },
      {
        value: "calendar.scheduling",
        label: "Scheduling",
        description: "Coordinate bookings, reminders, calendars, availability, or follow-ups.",
        inputShape: "schedule-request",
        deliveryShape: "calendar-update",
        capabilities: ["calendar", "scheduling", "reminders"],
        aliases: ["calendar", "schedule", "meeting", "booking", "reminder"],
      },
      {
        value: "email.outreach",
        label: "Email/outreach",
        description: "Draft, send, monitor, or triage outbound campaigns and replies.",
        inputShape: "outreach-brief",
        deliveryShape: "outreach-report",
        capabilities: ["email", "outreach", "follow-up"],
        aliases: ["email", "outreach", "campaign", "follow up"],
      },
      {
        value: "crm.enrichment",
        label: "CRM enrichment",
        description: "Update contacts, accounts, notes, opportunities, and CRM fields.",
        inputShape: "crm-records",
        deliveryShape: "crm-updates",
        capabilities: ["crm", "enrichment", "sales-ops"],
        aliases: ["crm", "sales", "contacts", "accounts"],
      },
    ],
  },
  {
    label: "Code/Infra",
    options: [
      {
        value: "code.review",
        label: "Code review",
        description: "Review a pull request, diff, repository, or implementation plan.",
        inputShape: "repo-or-diff",
        deliveryShape: "review-report",
        capabilities: ["code-review", "security", "quality"],
        aliases: ["code review", "pr", "diff", "review code"],
      },
      {
        value: "code.implementation",
        label: "Code implementation",
        description: "Implement a scoped code change, script, test, plugin, or integration.",
        inputShape: "implementation-brief",
        deliveryShape: "patch-or-pr",
        capabilities: ["coding", "tests", "patch"],
        aliases: ["implement", "code", "build feature", "patch"],
      },
      {
        value: "code.debug",
        label: "Debugging",
        description: "Investigate failures, logs, tests, incidents, or broken workflows.",
        inputShape: "bug-report",
        deliveryShape: "diagnosis-and-fix",
        capabilities: ["debug", "logs", "tests"],
        aliases: ["debug", "bug", "fix error", "logs", "failure"],
      },
      {
        value: "infra.deploy",
        label: "Deploy/infra",
        description: "Deploy, configure, monitor, or repair infra and service integrations.",
        inputShape: "infra-request",
        deliveryShape: "deployment-report",
        capabilities: ["deploy", "infra", "ops"],
        aliases: ["deploy", "server", "infra", "hosting", "ops"],
      },
      {
        value: "security.audit",
        label: "Security audit",
        description: "Review code, configs, access, contracts, or workflows for security risk.",
        inputShape: "audit-scope",
        deliveryShape: "security-report",
        capabilities: ["security", "audit", "risk"],
        aliases: ["security", "audit", "threat", "risk"],
      },
      {
        value: "plugin.setup",
        label: "Plugin/skill setup",
        description: "Install, configure, review, or publish a plugin, skill, or integration.",
        inputShape: "plugin-request",
        deliveryShape: "plugin-report",
        capabilities: ["plugin", "skill", "integration"],
        aliases: ["plugin", "skill", "integration", "setup"],
      },
      {
        value: "plugin.service",
        label: "Plugin service",
        description:
          "Expose a plugin capability as a paid service with structured result delivery.",
        inputShape: "plugin-service-request",
        deliveryShape: "plugin-service-result",
        capabilities: ["plugin", "capability", "service"],
        aliases: ["plugin service", "plugin capability", "extension service"],
      },
      {
        value: "skill.execution",
        label: "Skill execution",
        description:
          "Run an approved skill capability as a paid task with a receipt-backed result.",
        inputShape: "skill-request",
        deliveryShape: "skill-result",
        capabilities: ["skill", "capability", "execution"],
        aliases: ["skill", "skill execution", "capability execution"],
      },
    ],
  },
  {
    label: "Commerce",
    options: [
      {
        value: "merchant.invoice",
        label: "Invoice handling",
        description: "Create, route, verify, reconcile, or explain merchant invoices and receipts.",
        inputShape: "invoice-request",
        deliveryShape: "invoice-or-receipt",
        capabilities: ["invoice", "receipt", "payment-proof"],
        aliases: ["invoice", "receipt", "merchant", "payment request"],
      },
      {
        value: "merchant.fulfillment",
        label: "Fulfillment",
        description: "Coordinate order status, fulfillment, delivery proof, and customer updates.",
        inputShape: "order-request",
        deliveryShape: "fulfillment-update",
        capabilities: ["orders", "fulfillment", "support"],
        aliases: ["order", "fulfillment", "shipping", "delivery"],
      },
      {
        value: "merchant.catalog",
        label: "Catalog listing",
        description: "Create, update, enrich, or syndicate product/service listings.",
        inputShape: "catalog-data",
        deliveryShape: "catalog-updates",
        capabilities: ["catalog", "listing", "commerce"],
        aliases: ["catalog", "listing", "product", "sku"],
      },
    ],
  },
  {
    label: "Wallet/Market research",
    options: [
      {
        value: "trading.signal",
        label: "Market research",
        description: "Research markets and produce read-only notes, watchlists, or alerts.",
        inputShape: "market-brief",
        deliveryShape: "market-research-report",
        capabilities: ["market-research", "alerts", "analysis"],
        aliases: ["market research", "market", "alert", "watchlist"],
      },
      {
        value: "trading.execution",
        label: "Wallet action review",
        description: "Prepare wallet actions only under explicit wallet policy and approval gates.",
        inputShape: "wallet-action-intent",
        deliveryShape: "wallet-action-review",
        capabilities: ["wallet", "review", "policy-gated"],
        aliases: ["wallet action", "swap review", "transfer review", "policy review"],
      },
      {
        value: "wallet.ops",
        label: "Wallet operations",
        description: "Wallet reporting, reconciliation, policy review, or prepared transactions.",
        inputShape: "wallet-request",
        deliveryShape: "wallet-report",
        capabilities: ["wallet", "reconciliation", "policy"],
        aliases: ["wallet", "balance", "reconcile", "transfer", "policy"],
      },
    ],
  },
  {
    label: "Network",
    options: [
      {
        value: "agent.hosting",
        label: "Agent hosting",
        description: "Host, route, monitor, or operate agent services for another operator.",
        inputShape: "hosting-request",
        deliveryShape: "hosting-status",
        capabilities: ["hosting", "routing", "monitoring"],
        aliases: ["agent hosting", "host agent", "runtime", "node"],
      },
      {
        value: "node.operator",
        label: "Node operator",
        description: "Operate Fased Network, relay, gateway, or node services under clear terms.",
        inputShape: "operator-request",
        deliveryShape: "operator-status",
        capabilities: ["node", "operator", "federation"],
        aliases: ["operator", "node", "gateway", "federation node"],
      },
      {
        value: "federation.routing",
        label: "Fased Network routing",
        description: "Provide routing, directory, reachability, bridge, or relay services.",
        inputShape: "routing-request",
        deliveryShape: "routing-status",
        capabilities: ["routing", "directory", "relay"],
        aliases: ["routing", "relay", "directory", "federation"],
      },
      {
        value: "compute.batch",
        label: "Compute batch",
        description: "Run batch compute, model jobs, scraping, transforms, or queued workloads.",
        inputShape: "batch-job",
        deliveryShape: "job-artifacts",
        capabilities: ["compute", "batch", "jobs"],
        aliases: ["compute", "batch", "job", "worker"],
      },
      {
        value: "browser.research",
        label: "Browser research",
        description: "Browse, compare, inspect, and report on web pages or products.",
        inputShape: "research-brief",
        deliveryShape: "research-report",
        capabilities: ["browser", "research", "comparison"],
        aliases: ["browser", "web research", "compare", "research"],
      },
    ],
  },
];

export const MARKETPLACE_SERVICE_KIND_OPTIONS = MARKETPLACE_SERVICE_KIND_GROUPS.flatMap(
  (group) => group.options,
);

export function getMarketplaceServiceKindOption(
  value: string | undefined,
): MarketplaceServiceKindOption | null {
  const serviceKind = String(value ?? "").trim();
  if (!serviceKind) {
    return null;
  }
  return MARKETPLACE_SERVICE_KIND_OPTIONS.find((entry) => entry.value === serviceKind) ?? null;
}

export function getMarketplaceServiceKindLabel(value: string | undefined): string {
  const serviceKind = String(value ?? "").trim();
  return getMarketplaceServiceKindOption(serviceKind)?.label ?? (serviceKind || "Service");
}

const MARKETPLACE_MANUAL_SERVICE_KINDS = new Set([
  "task.general",
  "freelancer.service",
  "human.task",
]);

const MARKETPLACE_AUTOMATED_ADAPTER_SERVICE_KINDS = new Set([
  "data.lookup",
  "data.extract",
  "api.access",
  "data.feed",
  "plugin.service",
  "skill.execution",
]);

export function isMarketplaceManualServiceKind(value: string | undefined): boolean {
  return MARKETPLACE_MANUAL_SERVICE_KINDS.has(String(value ?? "").trim());
}

export function isMarketplaceAutomatedAdapterServiceKind(value: string | undefined): boolean {
  return MARKETPLACE_AUTOMATED_ADAPTER_SERVICE_KINDS.has(String(value ?? "").trim());
}

export function inferMarketplaceServiceKind(params: {
  title: string;
  summary?: string;
}): MarketplaceServiceKindOption {
  const haystack = `${params.title} ${params.summary ?? ""}`.toLowerCase();
  const scored = MARKETPLACE_SERVICE_KIND_OPTIONS.map((option) => {
    const score = option.aliases.reduce((total, alias) => {
      return haystack.includes(alias.toLowerCase()) ? total + alias.length : total;
    }, 0);
    return { option, score };
  })
    .filter((entry) => entry.score > 0)
    .toSorted((left, right) => right.score - left.score);
  return scored[0]?.option ?? MARKETPLACE_SERVICE_KIND_OPTIONS[0];
}
