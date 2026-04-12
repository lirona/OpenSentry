### Evidence Requirement
Every finding MUST cite a specific `file.sol:line`. Claims without code references are invalid. If you cannot find evidence for a concern, state "no evidence found" — never write "it probably works" or "this is likely safe."

### Anti-Hallucination
- Never reshape evidence to fit assumptions or rationalize unexpected code as 'probably fine'. When code contradicts your assumptions, revise your understanding—trust what the code actually does, not what you expected it to do.
- "I already know how ERC20 works" — Custom implementations diverge from standards. The divergence IS where bugs live.
- "This is a standard pattern" — Standard patterns in non-standard contexts create bugs. Context changes semantics.
- "This function is simple, I'll skim it" — Simple functions called by many other functions are the most dangerous when they contain bugs.
- "I already know how ERC20 works" — Custom implementations diverge from standards. The divergence IS where bugs live.
- "This is a standard pattern" — Standard patterns in non-standard contexts create bugs. Context changes semantics.
- "This function is simple, I'll skim it" — Simple functions called by many other functions are the most dangerous when they contain bugs.
- Don't infer absence from missing one pattern. "No `onlyOwner` modifier, so it's unprotected" — Access control may exist via custom modifiers, inline `require()` checks, role systems, or internal + validation. Grep ALL patterns: `onlyOwner|onlyRole|onlyAdmin|require\(msg\.sender|hasRole`.
- "SafeERC20 prevents this" or "OpenZeppelin protects this" — Don't trust library names. Verify the actual implementation. Version, fork, and wrapper details matter.
- "I don't see this `.call()` in the function" — Absence in one place doesn't mean absence everywhere. Grep the entire codebase. May be called via delegatecall, callback, or internal recursion.
- "The comment says it's only initialized contracts can call this" — Comments express intent, not guarantees. If code doesn't enforce the invariant, it's not safe.   

### False Positive Prevention
Do NOT report as findings:
- **Generic best practices**: "use SafeERC20", "add events", "missing NatSpec", "use Ownable2Step" — these are INFO at most, never WARNING or CRITICAL.
- **Dust-level precision**: Rounding <$0.01/tx, bounded truncation, precision loss < gas cost. `max_loss x max_iterations < $1` = dust.
- **Admin trust (unless destructive + irrevocable)**: Admin can change fees = INFO. Admin can drain funds without timelock = CRITICAL. The line is: can admin IRREVERSIBLY harm users?
- **Theoretical with exotic preconditions**: "If a fee-on-transfer token is used" without naming which specific token in the protocol's actual token list = not a finding.
- **Out of scope**: Token behaviors for unlisted tokens, chain issues on unsupported chains.

### Call-Chain Tracing
When a function calls another contract or internal function, treat the call chain as continuous execution. Follow the call, analyze the callee with the same rigor, then return to the caller with full understanding of what actually happens — not what the function name suggests.

### Mitigation Verification
Before promoting any grep hit or pattern match to a finding, actively search for existing mitigations. Check for: `nonReentrant` modifiers, require/assert guards, access control modifiers on callers, timelocks wrapping the operation, SafeERC20 wrappers, input validation in parent functions. If a mitigation exists, the issue is NOT a finding unless you can demonstrate the mitigation is bypassable. Cite the mitigation code when downgrading.

### Grep-First Mandate
Run all grep patterns listed in the Checks section BEFORE deep code analysis. Grep hits are surface signals — each match requires reading +/-20 lines of surrounding code and checking for mitigating factors before promotion to a finding.

### Finding Cap
Report a maximum of 5 findings, prioritized by severity (CRITICAL > WARNING > INFO). If more exist, note "N additional [severity] findings omitted" in the summary.

---

## Output Format

```json
{
  "agent": "<agent-name>",
  "severity": "SAFE|INFO|WARNING|CRITICAL",
  "findings": [
    {
      "check": "<check name>",
      "severity": "SAFE|INFO|WARNING|CRITICAL",
      "location": "file.sol:line",
      "summary": "<1-3 sentences plain English>",
      "detail": "<technical explanation with code references>",
      "user_impact": "<what this means for someone using this contract>"
    }
  ],
  "summary": "<1 sentence plain English summary for non-technical users>"
}
```
