/**
 * Oracle Pragmatist Skill
 *
 * Encourages code reuse and minimal solutions by applying the "Decision Ladder"
 * before writing code. Integrates with Oracle's memory system to find existing
 * implementations and avoid duplication.
 *
 * The ladder (in order):
 * 1. Does this need to exist? (YAGNI)
 * 2. Already in this codebase? (search memory + grep)
 * 3. Does stdlib do this?
 * 4. Does the platform provide it?
 * 5. Is there an installed dependency?
 * 6. Can this be one line?
 * 7. Only then: implement minimum
 */

export type PragmatistMode = 'conservative' | 'balanced' | 'aggressive' | 'off';

export interface PragmatistConfig {
  defaultMode: PragmatistMode;
  strictness: 'high' | 'normal' | 'low';
  remindOnEveryTask: boolean;
  rungStyle: 'verbose' | 'terse' | 'silent';
}

export interface PragmatistContext {
  mode: PragmatistMode;
  config: PragmatistConfig;
  task: string;
  codebaseContext: string;
  existingImplementations: string[];
}

/**
 * The Decision Ladder
 *
 * Returns the rung where the ladder "holds" (i.e., the answer that suggests
 * we don't need to write new code). If no rung holds, returns "implement".
 */
export async function climbLadder(context: PragmatistContext): Promise<PragmatistRung> {
  switch (context.mode) {
    case 'off':
      return { rung: 'implement', reason: 'Pragmatist mode is off', suggestion: '' };

    case 'conservative':
      return climbLadderFull(context);

    case 'balanced':
      return climbLadderBalanced(context);

    case 'aggressive':
      return climbLadderAggressive(context);
  }
}

interface PragmatistRung {
  rung: 1 | 2 | 3 | 4 | 5 | 6 | 'implement';
  reason: string;
  suggestion: string;
}

async function climbLadderFull(context: PragmatistContext): Promise<PragmatistRung> {
  // Rung 1: Does this need to exist?
  if (isDuplicateOrUnnecessary(context.task, context.codebaseContext)) {
    return {
      rung: 1,
      reason: 'This feature may not be necessary (YAGNI)',
      suggestion:
        "Question: can we achieve the goal without implementing this? Consider removing it entirely.",
    };
  }

  // Rung 2: Already in this codebase?
  const existing = context.existingImplementations[0];
  if (existing) {
    return {
      rung: 2,
      reason: `Found existing implementation: ${existing}`,
      suggestion: `Reuse the existing solution. Adapt if needed, but don't rewrite.`,
    };
  }

  // Rung 3: Does stdlib do this?
  const stdlibMatch = checkStdlib(context.task);
  if (stdlibMatch) {
    return {
      rung: 3,
      reason: `Standard library provides this: ${stdlibMatch}`,
      suggestion: `Use ${stdlibMatch} instead of implementing.`,
    };
  }

  // Rung 4: Does the platform provide this?
  const platformMatch = checkPlatform(context.task);
  if (platformMatch) {
    return {
      rung: 4,
      reason: `Platform feature available: ${platformMatch}`,
      suggestion: `Use ${platformMatch} (HTML5, Web APIs, etc.)`,
    };
  }

  // Rung 5: Installed dependency?
  const depMatch = checkInstalledDependencies(context.task, context.codebaseContext);
  if (depMatch) {
    return {
      rung: 5,
      reason: `Already installed: ${depMatch}`,
      suggestion: `Use the ${depMatch} dependency already in package.json.`,
    };
  }

  // Rung 6: One line?
  if (isOneLineSolution(context.task)) {
    return {
      rung: 6,
      reason: 'This can be a one-liner',
      suggestion: 'Keep the implementation minimal (one line or simple expression).',
    };
  }

  // Rung doesn't hold: implement
  return {
    rung: 'implement',
    reason: 'Climbed the full ladder; no shortcut found',
    suggestion: 'Write the minimum implementation needed. Still include validation, error handling, tests.',
  };
}

async function climbLadderBalanced(context: PragmatistContext): Promise<PragmatistRung> {
  // Balanced: prioritize existing code, stdlib, platform; question YAGNI less
  const existing = context.existingImplementations[0];
  if (existing) {
    return {
      rung: 2,
      reason: `Found existing: ${existing}`,
      suggestion: `Reuse this.`,
    };
  }

  const stdlibMatch = checkStdlib(context.task);
  if (stdlibMatch) {
    return {
      rung: 3,
      reason: `Stdlib: ${stdlibMatch}`,
      suggestion: `Use it.`,
    };
  }

  const platformMatch = checkPlatform(context.task);
  if (platformMatch) {
    return {
      rung: 4,
      reason: `Platform: ${platformMatch}`,
      suggestion: `Use it.`,
    };
  }

  return {
    rung: 'implement',
    reason: 'No existing solution found; proceed with implementation',
    suggestion: 'Write minimal code. Validation and error handling are required.',
  };
}

async function climbLadderAggressive(context: PragmatistContext): Promise<PragmatistRung> {
  // Aggressive: strongly question necessity, prefer existing, question every line
  if (isDuplicateOrUnnecessary(context.task, context.codebaseContext)) {
    return {
      rung: 1,
      reason: 'Likely unnecessary',
      suggestion: 'Delete this feature. Are you *sure* you need it?',
    };
  }

  const existing = context.existingImplementations[0];
  if (existing) {
    return {
      rung: 2,
      reason: `Found: ${existing}`,
      suggestion: `Use it. Don't rewrite.`,
    };
  }

  const stdlibMatch = checkStdlib(context.task);
  if (stdlibMatch) {
    return {
      rung: 3,
      reason: `Stdlib has ${stdlibMatch}`,
      suggestion: `Use it only.`,
    };
  }

  const platformMatch = checkPlatform(context.task);
  if (platformMatch) {
    return {
      rung: 4,
      reason: `Platform: ${platformMatch}`,
      suggestion: `${platformMatch} is your answer. Ship it.`,
    };
  }

  return {
    rung: 'implement',
    reason: 'After aggressive questioning: implement minimum',
    suggestion: 'Write the fewest lines possible. Every line must earn its place.',
  };
}

/**
 * Helper functions for climbing the ladder
 */

function isDuplicateOrUnnecessary(task: string, codebase: string): boolean {
  const unnecessaryPatterns = [
    'wrapper',
    'abstraction layer',
    'utility for a one-off',
    'configuration for a library we barely use',
  ];
  return unnecessaryPatterns.some((p) => task.toLowerCase().includes(p));
}

function checkStdlib(task: string): string | null {
  const stdlibMatches: Record<string, string> = {
    'read file': 'fs.readFileSync() or fs.promises.readFile()',
    'write file': 'fs.writeFileSync() or fs.promises.writeFile()',
    'parse json': 'JSON.parse()',
    'stringify': 'JSON.stringify()',
    'promises': 'Promise, async/await',
    'array map': 'Array.map()',
    'array filter': 'Array.filter()',
    'array reduce': 'Array.reduce()',
    'http': 'fetch() (browser) or http (Node)',
    'url': 'URL or new URL()',
    'crypto': 'crypto module (Node) or Web Crypto API',
    'timer': 'setTimeout(), setInterval()',
  };

  for (const [pattern, stdlib] of Object.entries(stdlibMatches)) {
    if (task.toLowerCase().includes(pattern)) {
      return stdlib;
    }
  }
  return null;
}

function checkPlatform(task: string): string | null {
  const platformMatches: Record<string, string> = {
    'date picker': '<input type="date">',
    'color picker': '<input type="color">',
    'number input': '<input type="number">',
    'storage': 'localStorage or IndexedDB',
    'fetch': 'fetch() API',
    'worker': 'Web Workers',
    'clipboard': 'Clipboard API',
    'geolocation': 'Geolocation API',
    'notification': 'Notification API',
  };

  for (const [pattern, platform] of Object.entries(platformMatches)) {
    if (task.toLowerCase().includes(pattern)) {
      return platform;
    }
  }
  return null;
}

function checkInstalledDependencies(task: string, codebase: string): string | null {
  // In a real implementation, parse package.json and match against task
  // For now, just check if common libraries are likely installed
  const commonLibs = ['lodash', 'date-fns', 'axios', 'express', 'react', 'vue'];
  for (const lib of commonLibs) {
    if (codebase.includes(lib) && task.toLowerCase().includes(lib.split('-')[0])) {
      return lib;
    }
  }
  return null;
}

function isOneLineSolution(task: string): boolean {
  const oneLiners = [
    'reverse array',
    'sort array',
    'uppercase string',
    'parse number',
    'check if array includes',
  ];
  return oneLiners.some((p) => task.toLowerCase().includes(p));
}

/**
 * Format the pragmatist ladder for display
 */
export function formatLadder(rung: PragmatistRung, style: 'verbose' | 'terse' | 'silent'): string {
  if (style === 'silent') return '';

  if (style === 'terse') {
    return `🎯 Pragmatist rung ${rung.rung}: ${rung.reason}. ${rung.suggestion}`;
  }

  // verbose
  return `
┌─ Oracle Pragmatist: Decision Ladder ─────────────────┐
│
│ Rung: ${rung.rung}
│ Reason: ${rung.reason}
│ Suggestion: ${rung.suggestion}
│
│ Safety note: Validation, error handling, security,
│ and tests are still required—never cut those.
│
└──────────────────────────────────────────────────────┘
`;
}

/**
 * Apply pragmatist mode to an agent task
 */
export async function applyPragmatist(
  task: string,
  codebaseContext: string,
  config: PragmatistConfig,
  existingImplementations: string[]
): Promise<string> {
  const context: PragmatistContext = {
    mode: config.defaultMode,
    config,
    task,
    codebaseContext,
    existingImplementations,
  };

  const rung = await climbLadder(context);
  const formatted = formatLadder(rung, config.rungStyle);

  // Build the instruction to inject into the agent prompt
  return `
## Oracle Pragmatist Skill (Mode: ${config.defaultMode})

${formatted}

Before writing code, climb the ladder:
1. Does this need to exist? (YAGNI)
2. Already in this codebase? → reuse it
3. Does stdlib do this? → use it
4. Does the platform provide it? → use it
5. Is there an installed dependency? → use it
6. Can this be one line? → one line
7. Only then: the minimum that works

Current recommendation: ${rung.rung === 'implement' ? 'Implement minimum' : `Stop at rung ${rung.rung} (${rung.reason})`}
`;
}
