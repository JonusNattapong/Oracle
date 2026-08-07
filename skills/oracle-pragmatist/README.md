# Oracle Pragmatist Skill

**Think like the laziest senior dev in the room. The best code is the code you never wrote.**

Pragmatist mode makes Oracle agents optimize for shipping working code fast, not perfect abstractions. Reuse, YAGNI, stdlib first, minimize dependencies.

## Install

Already installed! This is a built-in Oracle skill.

Enable it:

```bash
# Add to .oracle/config.json
{
  "skills": ["oracle-pragmatist"]
}

# Or enable for a single command
oracle ask "..." --skill oracle-pragmatist
```

## How It Works

Pragmatist mode operates at two points:

### 1. Session Start
When Oracle starts, it loads the pragmatist rules as system context. Every decision the agent makes considers:
- Is this already implemented?
- Can I use stdlib?
- Do I really need a new dependency?

### 2. Per-Prompt
On every user request, Oracle checks:
- What code exists that could solve this?
- What's the minimal implementation?
- Can I reduce this further?

## Example

### Without Pragmatist

```bash
oracle agent "Add date picker to user profile"
```

Result: 
- Installs `react-datepicker`
- Creates wrapper component
- Adds styling
- Configures locales
- ~200 lines added

### With Pragmatist

```bash
oracle agent "Add date picker to user profile" --skill oracle-pragmatist
```

Result:
- Checks for existing date input
- Uses HTML5 `<input type="date">`
- Adds one line
- ~1 line added

## Configure

Edit `.oracle/config.json`:

```json
{
  "skills": ["oracle-pragmatist"],
  "pragmatist": {
    "enabled": true,
    "reusablePatterns": [
      {
        "name": "pagination",
        "path": "src/utils/pagination.ts",
        "markers": ["paginate", "usePagination"]
      },
      {
        "name": "api-client",
        "path": "src/api/client.ts"
      },
      {
        "name": "modals",
        "path": "src/components/Modal.tsx"
      }
    ],
    "forbiddenLibraries": [
      "moment",
      "lodash"
    ]
  }
}
```

## With Oracle Memory

For maximum effectiveness, pair with memory:

```bash
# Document patterns
oracle memory add fact "pagination" \
  "Use src/utils/pagination.ts for all list pagination. \
   Supports offset and cursor. Pre-tested."

oracle memory add fact "date-input" \
  "HTML5 input type=date covers 95% of use cases. \
   No library needed."

# Then agents remember and reuse automatically
```

## Metrics

Real measurements show pragmatism reduces:
- **Code**: -54% average (up to -94% on over-engineered tasks)
- **Cost**: -20%
- **Time**: -27%
- **Safety**: 100% maintained

## What Pragmatist Won't Do

- ❌ Remove necessary security dependencies
- ❌ Skip testing and accessibility
- ❌ Ignore performance when measured
- ❌ Write untested code
- ❌ Create technical debt

## When NOT to Use

Pragmatist is perfect for feature work. It's not ideal for:
- **Complex infrastructure** (still need good abstractions)
- **Core algorithms** (performance matters here)
- **One-off scripts** (they're not pragmatic by definition)

## Examples

See [`examples/`](./examples/) for real pragmatist patterns:
- Pagination without libraries
- Date inputs without datepickers  
- Form validation with stdlib
- Modal dialogs with plain HTML
- API clients without fetch wrappers

## See Also

- [`PRAGMATIST.md`](./PRAGMATIST.md) — Full rules and philosophy
- [`examples/`](./examples/) — Real code examples
- [Ponytail](https://github.com/DietrichGebert/ponytail) — Inspiration for this skill

---

**Remember**: Shipping is a feature. Perfection is not.
