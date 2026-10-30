# A night driver that opens separate sessions

**Status:** Rejected; removed.

Batch once started a separate headless session per task from a background
driver. It failed in real use in several independent ways (the lead skill
could not load, sandbox and process handling, test doubles hiding real
behaviour) and was removed.

## Instead

`/proofline batch` runs tasks one after another in the same session the
user started, with one approval that covers plan freezes and delivery,
questions asked up front, and parked tasks that do not stop independent
ones. The session must stay open and the machine awake.
