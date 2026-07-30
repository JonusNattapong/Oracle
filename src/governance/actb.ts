import path from "node:path";

export interface AwarenessReport {
  timestamp: string;
  workspaceRoot: string;
  activeAgentsCount: number;
  auditLoggingEnabled: boolean;
  costTrackerActive: boolean;
  status: "healthy" | "degraded" | "warning";
  metrics: {
    memoryNodesTracked: number;
    auditRecordsCount: number;
    tokenBudgetUsagePct: number;
  };
}

export interface ControlPolicyRequest {
  actionName: string;
  commandLine?: string;
  targetPath?: string;
  currentStep: number;
  maxSteps: number;
  policyMode: "off" | "risky" | "all-mutations";
  estimatedTokens?: number;
}

export interface ControlPolicyResult {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  suggestedAction?: string;
}

export interface MemoryTransformInput {
  tags: string[];
  content: string;
  importance?: number;
}

export interface MemoryTransformResult {
  normalizedTags: string[];
  consolidatedContent: string;
  similarityScore?: number;
  isDuplicate: boolean;
}

export interface BoundaryValidationResult {
  valid: boolean;
  resolvedPath?: string;
  reason?: string;
  isInsideWorkspace: boolean;
}

export class ACTBEngine {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Pillar I: Awareness Engine
   * Aggregates real-time governance metrics and system status.
   */
  public getAwarenessReport(
    trackedNodesCount = 0,
    auditCount = 0,
    budgetUsagePct = 0
  ): AwarenessReport {
    const isDegraded = budgetUsagePct >= 90;
    return {
      timestamp: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      activeAgentsCount: 1,
      auditLoggingEnabled: true,
      costTrackerActive: true,
      status: isDegraded ? "warning" : "healthy",
      metrics: {
        memoryNodesTracked: trackedNodesCount,
        auditRecordsCount: auditCount,
        tokenBudgetUsagePct: budgetUsagePct
      }
    };
  }

  /**
   * Pillar II: Control Engine
   * Assesses command/action risks, step limits, and human approval gates.
   */
  public evaluateControlPolicy(req: ControlPolicyRequest): ControlPolicyResult {
    if (req.currentStep >= req.maxSteps) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Exceeded max execution steps ceiling (${req.maxSteps}).`,
        riskLevel: "high"
      };
    }

    const isRiskyCommand = Boolean(
      req.commandLine &&
      /rm\s+-rf|sudo|chmod\s+777|curl.*\|.*sh|wget.*\|.*sh/i.test(req.commandLine)
    );

    if (isRiskyCommand) {
      return {
        allowed: req.policyMode === "off",
        requiresApproval: req.policyMode !== "off",
        reason: "Potentially destructive or system-altering command detected.",
        riskLevel: "critical",
        suggestedAction: "Pause execution and request explicit human approval via Control Center."
      };
    }

    if (req.policyMode === "all-mutations") {
      return {
        allowed: false,
        requiresApproval: true,
        reason: "Approval mode is set to 'all-mutations'. Every mutation requires human confirmation.",
        riskLevel: "medium"
      };
    }

    return {
      allowed: true,
      requiresApproval: false,
      reason: "Action evaluated cleanly under current control policy.",
      riskLevel: "low"
    };
  }

  /**
   * Pillar III: Transform Engine
   * Normalizes tags, computes similarity, and deduplicates working memories.
   */
  public transformMemory(
    input: MemoryTransformInput,
    existingMemories: MemoryTransformInput[] = []
  ): MemoryTransformResult {
    const normalizedTags = Array.from(
      new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))
    );

    let isDuplicate = false;
    let maxSimilarity = 0;

    for (const existing of existingMemories) {
      const existingTags = existing.tags.map((t) => t.trim().toLowerCase());
      const similarity = this.calculateJaccardSimilarity(normalizedTags, existingTags);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
      }
      if (similarity >= 0.8 || existing.content.trim() === input.content.trim()) {
        isDuplicate = true;
        break;
      }
    }

    return {
      normalizedTags,
      consolidatedContent: input.content.trim(),
      similarityScore: maxSimilarity,
      isDuplicate
    };
  }

  /**
   * Pillar IV: Boundary Engine
   * Enforces strict workspace path containment and verification state.
   */
  public validateBoundary(targetPath: string): BoundaryValidationResult {
    try {
      const abs = path.resolve(this.workspaceRoot, targetPath);
      const root = path.resolve(this.workspaceRoot);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        return {
          valid: false,
          reason: `Path escapes the workspace: ${targetPath}`,
          isInsideWorkspace: false
        };
      }
      return {
        valid: true,
        resolvedPath: abs,
        isInsideWorkspace: true
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        valid: false,
        reason: message,
        isInsideWorkspace: false
      };
    }
  }

  /**
   * Calculates Jaccard similarity index between two sets of tags.
   */
  private calculateJaccardSimilarity(setA: string[], setB: string[]): number {
    if (setA.length === 0 && setB.length === 0) return 1.0;
    if (setA.length === 0 || setB.length === 0) return 0.0;

    const intersection = setA.filter((x) => setB.includes(x)).length;
    const union = new Set([...setA, ...setB]).size;
    return intersection / union;
  }
}
