# Skills invoked by the model through the Skill tool

**Status:** Rejected.

Every proofline skill carries `disable-model-invocation: true`. Skills are
loaded by reading their `SKILL.md` file by path, never through the Skill
tool.

## Why rejected

Removing the flag would let a model start proofline workflows on its own,
outside a command the user typed. The runtime rejects a Skill-tool call to
these skills before hooks run, so the reliable path is reading the file.

## Instead

Entry skill, lead and role files all say: read the file by its path. Do not
remove the flag to "fix" a model that tried the Skill tool.
