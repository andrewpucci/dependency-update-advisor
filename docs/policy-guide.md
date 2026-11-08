# Policy guide

This guide explains the policy result shown in each package assessment of a
Dependency Update Advisor comment. It describes the shared **defaults**. A
repository can override them, so the result in a comment is authoritative for
that review and this page is not.

## The three outcomes

| Outcome                | Meaning                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `merge`                | Policy found nothing that holds or qualifies this update.                  |
| `merge with followups` | Policy allows merging, but a finding needs a follow-up the comment names.  |
| `do not merge`         | Policy holds the update until the named blocker is resolved or overridden. |

The displayed outcome is the most permissive verdict policy allows for that
package or group (its ceiling). An assessment can be stricter than its
ceiling, never more permissive. `merge` is not proof that evidence is
complete; the assessment also shows whether its evidence is complete or
partial.

## Default rules

Each rule applies only when verified evidence supports it. Unverified model
text cannot trigger a rule.

| Rule                          | Applies when                                                                                | Default                |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ---------------------- |
| `highOrCriticalVulnerability` | A verified unresolved critical or high advisory affects the proposed version.               | `do_not_merge`         |
| `incompatibleMigration`       | Verified evidence and repository context prove an incompatible migration.                   | `do_not_merge`         |
| `moderateOrLowVulnerability`  | A verified unresolved moderate, low, or unscored advisory affects the proposed version.     | `merge_with_followups` |
| `applicableCodemod`           | Verified upgrade evidence shows an applicable codemod.                                      | `merge_with_followups` |
| `compatibilityUncertainty`    | Verified evidence shows a change that may break supported runtimes or downstream consumers. | `merge_with_followups` |
| `supplyChainChange`           | A changed install script, package source, publisher, trust level, or Action identity.       | `merge_with_followups` |
| `licenseChange`               | Declared license identifiers differ between the current and proposed versions.              | `merge_with_followups` |
| `recentRelease`               | The proposed version is newer than the minimum release age (default one day).               | `merge_with_followups` |
| `deprecatedRelease`           | Registry metadata marks the proposed version deprecated or yanked.                          | `merge_with_followups` |
| `incompleteEvidence`          | Required evidence is partial or unavailable.                                                | `merge_with_followups` |

A verified malware advisory against a proposed version is a fixed hold:
`do_not_merge`, with no override. Unchecked optional signals, such as a
failed publication-time lookup, are reported but never create or remove a
finding.

When several rules apply, the strictest verdict wins:
`do_not_merge` over `merge_with_followups` over `merge`.

## How local overrides change the result

A repository can set `policy.verdicts` in `.github/dependabot-review.json`
to replace the default verdict of any rule above with `merge`,
`merge_with_followups`, or `do_not_merge`, and set
`policy.minimumReleaseAgeDays`. Rules left out keep their defaults.

- An override changes the advice, not the evidence. A relaxed finding stays
  in the comment with its remediation.
- Relaxing one rule may not change the displayed outcome when another
  finding still sets the same or a stricter one.
- Unresolved units and evidence gaps remain visible whatever the overrides.
  A relaxed outcome never turns an unresolved or failed review into a merge
  recommendation.
- Malware holds cannot be overridden.

To see which settings your repository uses, read its own
`.github/dependabot-review.json`; this guide does not know them.
