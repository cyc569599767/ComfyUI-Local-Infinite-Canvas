# short-drama-h3-prompt skill

Imported from the local WorkBuddy skill directory (`short-drama-h3-prompt`,
`_user_meta.json` records `source: userImport`). Copied into the gateway on
2026-11-13 so the cloud prompt optimizer can reach it at runtime.

The skill defines short-drama production rules for MiniMax H3 Ref2VA prompts:
character/costume/hair/position locking, speaking-rate and breath-pause
calculation, reference-image numbering, and the "lock the camera on whoever is
speaking" rule. It is designed to be read together with `h3-prompt-writing`,
which supplies the six-section field format.

The gateway loads it only in full-reference (Ref2VA) mode, and strips the
sections that describe a multi-turn human workflow rather than generation rules
(`工作流程`, `分镜表规范`, `交付检查清单`, `与 h3-prompt-writing skill 的关系`,
`模板文件`, plus the storyboard template in `references/template.md`). It does
not modify any of the retained rules.

No license file was provided with the imported skill. Confirm the terms before
distributing this repository outside its current audience.
