# Crackle user workflows

This is the normative operator-workflow checklist beneath the
[product specification](../../docs/product-spec.md).

It describes what an operator is trying to accomplish, where they do it, what is saved, and which copy
wins. It is also the review checklist for UI work: if a change adds a second route to the same
outcome, hides a required step, or makes the browser look more authoritative than the roaster, it
should be reconsidered.

## The source-of-truth rule

The roaster owns status, actuation, applied calibration, profiles, bean lots, roast records,
recordings, and backup metadata. The browser has one legitimate reason to differ: a visible working
edit that has not been saved. Busy, stale, degraded, or offline saves remain uncommitted; only a
successful device response advances committed browser state.

On connection, the browser reads the roaster and the roaster wins over its cache. While a roast,
calibration pass, or Controls session is active, the roaster remains in charge and reports the values
the UI displays. A browser can close after starting an autonomous roast; the roast continues on the
roaster.

The small lamp beside Fan, Heat, and Temp is the browser's view of device-report freshness. Green is
current through 3 seconds and flashes solid on each accepted fresh report; yellow means more than 3
seconds; red means more than 5 seconds or disconnected. It is reassurance and diagnosis only. A roast
continues under device ownership if the browser or this display disappears.

| Browser state | What the operator sees | What may happen next |
| --- | --- | --- |
| Clean and connected | The roaster's current library and status | Edits begin as a working copy |
| Unsaved editor draft | `Unsaved working edits`; leaving asks first | Save commits a new device version |
| Save while busy | The form remains an unsaved working edit | Retry after the roaster is idle and the browser is current |
| Version conflict | The fresh device document is fetched and the edit is replayed once | A second conflict is surfaced without overwriting device state |
| Telemetry gap, reboot, stale, or disconnected | Cached records stay readable; mutations fail closed | Status, exact active plan, and library reconcile automatically; safety Stop remains available |

The leave prompt is raised only by work that exists nowhere but the open tab: Profiles and Beans
drafts, the Roast page's completed-roast details and queued manual steps, and History edits. State the
roaster already holds, such as the post-roast decision about an edited journey, never raises it, and an
edit returned to its stored value is clean.

## Normal operating loop

1. **Prepare a bean lot, if useful.** Open **Beans**, choose **New lot**, enter the bag facts worth
   preserving, and save. Bean metadata is optional for roasting but makes comparisons and density
   measurements meaningful.
2. **Prepare a profile, if using automation.** Open **Profiles**, choose **New timed** or
   **New journey**, author the recipe, then save. Journey profiles always show a local simulation;
   timed profiles do not need one because they are a fixed actuator schedule. Existing recipes can be
   duplicated or revised; saved revisions remain inspectable.
3. **Run the roast.** Open **Roast**, choose the bean lot and profile, enter this batch's mass and
   optional volume/name, optionally choose a finished roast to **Compare with** on the chart, decide
   whether to keep detailed 1-second telemetry, then Start. Either telemetry choice creates an
   authoritative device archive: detailed uses 1-second samples and compact uses 10-second samples. Start first writes the complete run record - volume, ambient, bean lot, mass, name - to the
   roaster's library, then commands the roast; if the roaster refuses the record, the roast does not
   start and the reason is shown. Every browser reading the roaster therefore sees the whole record
   from the moment the roast begins, and the finished recording later completes that same record. The
   roaster validates and owns the plan. Crackle watches its reported state and keeps Stop available
   while it is active. Header Stop is a normal operator-requested end: it turns Heat off immediately,
   runs the roaster's ten-second Fan 10 cooling pass (any new command preempts it), finalizes the
   active roast as stopped, and retains the recording in History. The comparison selector appears
   before and after a roast, not while outputs are running: a comparison chosen beforehand stays
   drawn under its Comparison key, and with no finished roast the selector is absent.
4. **Review the result.** When the roaster finishes and cools, the roast appears in **History**.
   Expand it to see the stored temperature curve, add final measurements, a 1-10 score, and notes,
   compare its curve, draft a profile from what actually ran, or choose **Roast again** to prefill the
   recorded profile, bean, mass, and volume on the Roast page. While the roast is still running or its
   recording has not reconciled, the expanded record is an explicit "Loading this roast..." state with
   the reason; it never renders a partial record that later changes in place. The Roast page keeps
   showing the finished roast's plan until another profile (or **Roast again**) is chosen; from then
   on, Start runs the chosen profile.
5. **Refine deliberately.** Use History evidence to revise the profile or bean notes. Save creates a
   new device version; loading an older revision changes only the working copy until Save is pressed.
6. **Back up periodically.** In **Settings > Storage**, choose **Back up now**. The zip contains
   library records, recordings, and the applied calibration. It does not restore the controller's NVS
   thermocouple correction; verify and reapply that value in Settings after a restore. Each recording
   still identifies the correction that was already applied when it was captured.

## Roast variants

Every roast preselects the detailed 1-second recording; the compact 10-second recording is an
explicit storage choice. The Roast page warns before Start when a profile ends while the heater is on,
because an automatic ending stops both outputs without a cooling pass. It shows a notice whenever the
roaster reports a weak Wi-Fi signal (-78 dBm or weaker), which makes pages slow and live status stall.

### Saved timed profile

- Choose a `Timed / ...` profile on **Roast**.
- The preview shows the planned Fan and Heat lanes.
- Start hands the complete schedule to the roaster; the browser is not the scheduler.
- Stop requests an early end: Heat is off at once, and the roaster follows with its ten-second Fan 10
  cooling pass before both outputs go idle. The pass never blocks a newer command; a second Stop or
  any manual instruction preempts it immediately.

### Saved temperature journey

- Choose a `Journey / ...` profile.
- A journey requires usable probe data and calibration coefficients applied on the roaster.
- The preview and live target use the roaster's applied coefficients. A newer browser-side fit is only
  a working candidate until it is explicitly applied.
- A modelled unreachable-zone result is a prediction warning, not a start refusal. It states the
  complete Fan/Heat ranges and, when known, the applied fit's replay error. Batch mass changes
  modelled approach time, not attainable equilibrium. Matching saved evidence that already reached the
  endpoint inside those ranges overrides a lower fitted ceiling.
- The roaster never silently advances past a missed endpoint. Its device-owned runtime envelope stops
  all outputs after twice the nominal plan duration plus ten minutes and records `envelope_timeout`;
  the browser cannot extend or replace that boundary. The predicted full process follows the same
  whole-plan envelope: it may finish earlier when the final cooling endpoint is attained, but it never
  abandons an individual zone on a shorter browser-only timer.
- The roaster advances zones from measured attainment, not from browser elapsed time. To avoid command
  chatter, journey Heat in heating zones changes by at most 0.25 level each 1-second control tick;
  cooling zones, a lowered Heat ceiling, Stop, faults, and safety reductions apply immediately.
- Journey begins at Fan 10 and holds full airflow through 130 °C, and that opening floor can override
  an authored lower Fan ceiling. Above 130 °C there is no other protective floor: the solver picks the
  greatest airflow whose required Heat can still deliver the requested rate, bounded only by the
  zone's authored Fan minimum and the universal rule that Heat on means Fan 1.0 or higher, and Fan
  moves to that answer immediately, for reductions and increases alike. Cooling uses Fan 10 / Heat 0.
  If a batch does not circulate well at low Fan, raise the zone's Fan minimum.
- While it runs, the exact device-held plan is shown. Completed zones are locked; the current and
  future zones can be adjusted, but the roaster validates and owns every accepted change.
- A change that would immediately cross the current zone endpoint requires a second explicit
  confirmation. After the roast, the retained initial plan keeps the full zone table visible and
  highlights each changed field with its previous value. Only a device-reported completed roast may
  save the result as a new profile revision; an early-stopped or faulted roast keeps the edits only as
  History evidence.

### Recordable manual roast

- On **Roast**, choose **Manual roast / Fan and heat**, or use **Controls > Start a recordable manual
  roast** to arrive there.
- Enter the bean, batch, name, initial Fan/Heat, and whether to keep detailed telemetry, then Start.
- Apply Fan/Heat changes from the live cockpit. Each accepted change is logged with its time,
  requested and effective levels, while the actual temperature curve continues to come from the
  roaster.
- Planned changes are multiple elapsed-time rows. The table sorts them chronologically and the next
  row counts down from the roaster's reported elapsed time, then shows **Due now**. Timing is
  advisory: Crackle never auto-applies a row from a browser timer; press **Apply this step** to send it
  and make it authoritative.
- Stop ends the roast: Heat is off immediately, the roaster runs its ten-second Fan 10 cooling pass
  (preempted by any newer command), and the manual recording closes at that operator-owned boundary;
  the cooling pass is post-record. The interface may briefly wait for the bounded archive write and
  History reconciliation; it does not wait for a calibration-style passive-decay tail.
- Once the authoritative archive arrives, name and save the accepted instruction path as a new timed
  profile, use the loaded-roast archive as optional calibration evidence, or choose Done. The roast is
  already saved in History and does not require a catalog profile. Calibration navigation only adds
  the exact recording to the working evidence list; it never ticks, fits, saves, or applies it
  automatically.

### Controls

- Use **Controls** for actuation without a bean/batch/history record: setup, diagnosis, or a short
  hold. Controls are unavailable while any roast is active.
- Enter Fan and Heat, then **Start controls**. Apply new levels without stopping first.
- The roaster reports commanded versus effective output and lifts Fan to at least 1.0 while Heat is
  positive.
- A standing instruction expires after its 30-minute lease and both outputs stop. Stop is disabled
  while no owned session is active, so this page cannot terminate another program accidentally.

### Stopping

Every Stop control that would end an active roast arms on the first tap ("Tap again to stop") and
fires on the second, then disarms itself after a few seconds. It is an in-place arm on the same
button, never a dialog. Stops that do not end a roast (Controls, calibration) are single-tap. The
transport Stop is never preflighted and never refused.

## Catalog workflows

### Bean lots

- Select an existing lot or create a new browser working draft. With no saved lots, that draft is
  already open; **New lot** never writes a blank record. Only Save commits it to the roaster.
- Edit the working copy; Save is enabled only when values differ. A valid bulk-density calculation
  such as `225/350` counts immediately without requiring a change in another field.
- New saved lots start first. Drag the left-list handle to change the controller-owned order; Roast
  and every other bean selector use that same order. The lot list can also be ordered by score, most
  recent roast, or name; a lot's score is the mean of its scored roasts and is never entered directly.
- The lot's roast table links back to History.
- Deleting only the lot leaves historical roasts intact because every roast embeds its bean snapshot.
- Cascade deletion is a separate, named, typed-confirmation workflow and only runs while the roaster
  is connected and idle.

### Profiles

- A new roaster starts with two profiles, installed once when its library has never held a profiles
  document: **Espresso Express**, a fast temperature journey to a dark espresso roast (listed and
  selected first), and **Espresso Express (timed)**, a lighter espresso on a fixed schedule for
  150-200 g batches. They are ordinary profiles afterwards: edit, reorder, or delete them; deleting
  every profile never brings them back.
- Select, reorder, duplicate, or create a timed/journey profile. New saved profiles start first and
  the controller-persisted drag order is also the order of the Roast selector.
- Edit the working copy. Journey simulation never applies or saves anything; timed profiles have no
  simulation because their exact Fan/Heat schedule is already shown.
- Duration fields display `m:ss`. A bare whole or decimal number is read as minutes and normalizes on
  commit (`3` becomes `3:00`; `3.5` becomes `3:30`), immediately updating the working chart.
- Save writes a new revision only when content changed.
- Loading a prior revision changes the editor, not device history; Save is still required.
- Deleting only the profile leaves historical roasts intact because every roast embeds its recipe.

## History and data transfer

- **History** is the roast-record review surface. Measurements, score, and notes remain a visible
  local draft until **Save changes** is pressed; typing and blur never write. A failed save retains the
  complete draft and shows the exact controller error plus **Try save again**, with no background
  retry loop. Expanded rows show the stored roast curve, and **Roast again** prefills the Roast setup
  without starting it. Its source control sits beside Filter and defaults to the active roaster; "All
  roasters" is an explicit cross-device view rather than an accidental identity fallback.
- At phone width, every table with hidden columns offers a **Sort by** menu.
- A manual roast's displayed duration ends where its immutable samples enter the final Heat-off
  suffix. Pressing Stop later still ends the controller session, but retained cooling time is not
  presented as roasting time.
- **Export history** creates a legacy JSON transfer containing roast history, not a full backup.
- **Import history** merges that legacy JSON by record id and asks before replacing collisions.
- **Settings > Back up now** creates the restorable library/recording/applied-calibration zip. The
  controller's current NVS thermocouple correction must be verified after restore; each v4 recording
  still carries its own capture-time correction.
- **Settings > Restore** opens a file picker, validates and summarizes the zip, then asks for
  confirmation before replacing device data. It is idle-gated and never silently merges.
- Per-kind export/import in Settings is the intentional merge workflow for profiles, beans, roasts, or
  calibrations. Identical records skip; conflicting records get one explicit file-wide choice.

## Calibration workflows

1. **Inspect what is applied.** **Calibrate > Current calibration** shows the coefficients and
   evidence the roaster is using plus empty-chamber Heating and Cooling response maps. Fan is the
   vertical axis, Heat is the horizontal axis, and color means calculated settling time. Loaded-roast
   predictions are shown against their measured temperature timeline instead of as synthetic
   equilibrium heatmaps. Ticking candidate data elsewhere must not change this applied section.
2. **Record a baseline when needed.** Run an empty-chamber diagnostic after setup, cleaning, repair, or
   suspected drift. The roaster runs the programmed steps, turns both outputs off, and stores the
   detailed recording with the exact accepted steps, dwell/settle policy, effective outputs,
   sensor-validity gaps, and applied thermocouple correction. Crackle fetches both CSV measurements and
   the matching `.crk` provenance, then adds one collapsed, unchecked result; an open browser draft can
   never relabel it.
3. **Build from evidence.** Add loaded-roast recordings and choose relevant empty-chamber baselines.
   Recording identity and provenance are read-only; if the wrong recording was added, the row's X
   removes it only from the current build selection. Permanent deletion from the roaster is a separate,
   explicitly labelled trash action on saved evidence, so adding and removing build inputs are
   symmetric and non-destructive. Repeated baseline cells are pooled and can legitimately leave a
   median unchanged. Ambient comes from the coolest cold-junction value in the recording's late tail,
   not a heat-soaked first restart sample. The loaded fit simulates the full trace but scores after the
   opening three-minute turnaround; selected baseline evidence may supply directly measured airflow
   cooling while the loaded roast supplies heater gain and bean-side thermal loss. Preview shows the
   measured and fitted loaded trace plus empty-chamber response maps. The coefficient/RMS comparison
   and maps remain local analysis only. If deterministic fits from materially different cooling seeds
   explain the evidence nearly equally well, Crackle blocks Save/Apply and asks for a complete fan-only
   cooling tail and baseline same-Heat Fan changes. It does not turn that ambiguity into a
   plausible-looking coefficient.
4. **Save and apply deliberately.** Review the coefficient comparison, then use **Save and apply**
   while the roaster is idle. Only the device-confirmed apply changes runtime control.

Use clean starts for loaded evidence: a roast begun in a warm or hot chamber, or one that was cut
short, describes a different starting condition and should be left out of the build. The method and
model are described in [`docs/control-and-calibration.md`](../../docs/control-and-calibration.md).

## Storage and maintenance

- **Settings > Storage** uses the roaster's own LittleFS totals and thermal-recording list, labelling
  each archive as Detailed (1 second) or Compact (10 seconds). While the recording list is still being
  read, it says so rather than reporting an empty archive.
- One browser serializes manifest, document, and recording work through a per-controller FIFO and
  waits through explicit transient `503 + Retry-After` responses for a bounded period. Firmware holds a
  three-request FIFO behind its single storage worker, so a phone and PC burst is queued rather than
  presented as an empty catalog.
- The capacity estimate is based on this roaster's measured average recording and roast-record size.
- Deleting a thermal recording removes that device archive. Delete is enabled only after a compact
  roast curve or calibration evidence preserves the useful result; otherwise the row names the
  preservation step. The separate roast/evidence record remains.
- Deleting roasts, profiles, beans, or calibrations reclaims their document bytes. The impact panel
  names linked records before destructive cascades.
- When a new recording would cross the retention reserve, Roast warns before Start and names what
  would be pruned. Turning off detailed recording selects a much smaller 10-second archive; it does not
  remove the authoritative occurrence, plan, accepted edit journal, or review curve.
- Firmware and web assets live in the OTA application slot. Decreasing their gzip size creates OTA
  headroom, not LittleFS recording capacity. Only a partition-table change can transfer space between
  them.

## Installed roaster and development recovery

- **Settings** shows the stable device/model identity reported by the connected controller. The
  browser does not choose or infer the model. Every roast, manual event, calibration run/snapshot, and
  thermal archive records that producer identity; backup and restore preserve it even when the
  destination roaster assigns a different local storage address.
- In production the installed roaster is the controller serving the page. Routine Roast, Beans,
  Profiles, Controls, Calibrate, and Reference screens treat it as the one appliance; device identity
  stays in stored provenance instead of becoming normal workflow chrome. In local development,
  **Settings > Choose a roaster** switches between the explicit mock and the configured physical-roaster
  proxy, while History keeps its explicit cross-device source filter. Crackle verifies candidate
  identity and type, keeps separate target/device caches, and performs a full-page handoff only while
  both controllers are safe to switch.
- In local simulation only, **Settings > Advanced > Power-cycle mock roaster** replaces volatile
  runtime state, changes the boot ID, and preserves controller documents, recordings, applied
  calibration, and stable device/model identity. Use it to test reconnect recovery or escape a
  deliberately interrupted mock run. **Drop live stream** exercises the reconnect path the same way.

## Update and fault workflows

- Firmware upload lives in **Settings > Advanced** and is accepted only while the roaster is idle.
  Normal updates are A/B OTA; a partition-table migration is a one-time serial operation, performed
  only with roaster mains and the charger disconnected before computer USB is attached.
- A stale connection, invalid thermocouple, manual lockout, or active program blocks starts with the
  roaster's reason visible.
- A latched actuator fault or manual-control conflict shows a persistent full-width banner on every
  view, naming the fault and stating that actuation stays disabled until the roaster is power-cycled.
- **Settings > Advanced > Controller diagnostics** names the last reset reason and recent boots,
  uptime, heap/PSRAM minima, longest loop gap, archive-save timing, slowest storage request, Wi-Fi
  signal and drop count, and decoded probe-fault bits. These are diagnostic observations and never
  weaken a control gate.
- Fault and effective-output displays always come from the roaster. Browser predictions may explain a
  limit but never overwrite the reported result.
