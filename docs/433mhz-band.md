# 433 MHz band reporting — what CoreScope is doing, and what coredrive-rx needs

Living document. CoreScope side updates it as work lands, so this repo can plan
against it rather than guess. Last updated **2026-09-23**.

## The problem

MeshCore runs on 868 MHz in the EU, 915 MHz in the US, and there is now 433 MHz
traffic. Nothing in a packet says which band it arrived on — the firmware's
`Packet` struct is header, `path_len`, `payload` and transport codes, and the
frequency is a property of the receiver, not of the transmission. Operators are
currently working around this by putting `| 433` in node names, which is a
convention, not data, and it breaks the moment someone writes it differently.

The band can only come from **the receiver's own radio config**. A transmission
is only ever heard by receivers on its band, so the band of an observation is
the band of whoever heard it.

Measured on a 1.9k-node production deployment over 7 days, which is also a
sanity check on the whole approach:

| | |
|---|---|
| transmissions heard only by the 433 observer | 1,875 |
| transmissions heard only by 868 observers | 122,536 |
| transmissions heard by **both** bands | **0** |

Zero is what the physics requires. If that number were not zero the method
would be wrong.

## Where coredrive-rx comes in

Fixed observers already publish their radio config, and CoreScope stores it as
`observers.radio` (`"freq,bw,sf,cr"`, e.g. `"869.6179809,62.5,8,8"`). On the
reference deployment **40 of 42 active observers** publish it.

**The two that do not are `kiekr-android` clients** — the mobile side. Together
they account for 76,421 of 1,741,446 observations over 7 days, about **4.4%**,
and they are the entire remaining gap. Everything a mobile client contributes
is currently unattributable to a band.

**Correction (2026-09-23): that gap is not coredrive-rx, and this repo cannot
close it.** `kiekr-android` is a different app. Its data is counted in
`observations`, so it publishes on the observer path
(`meshcore/<iata>/<id>/…`). coredrive-rx never reaches `observations`: it
publishes only on `meshcore/client/{pk}/{packets,rf,regions}`, and
`handleMessage` in `cmd/ingestor/main.go` returns from the `parts[1] == "client"`
branch into `client_receptions` / `client_rf_samples` / `client_regions` before
the observer path runs. The string "kiekr" does not occur in `corescope-rx/src`,
`CoreScope/cmd` or `CoreScope/public`. The 4.4% closes only when
`kiekr-android` puts `radio` in its own `/status`.

What the steps below would give instead is band attribution for coredrive-rx's
own client tables, which starts to matter once a companion drives on 433. On
the reference deployment that data does not arrive at all today
(`clientRxCoverage` is off, see below).

## The good news: the companion already tells you

No firmware change is needed, and no new BLE command. The frequency is already
in the `SELF_INFO` frame this app parses at connect.

From `examples/companion_radio/MyMesh.cpp` in the firmware (read at commit
`0679dbef`), the `RESP_CODE_SELF_INFO` reply to `CMD_APP_START` is laid out:

```
offset  size  field
0       1     RESP_CODE_SELF_INFO (0x05)
1       1     adv_type
2       1     tx_power_dbm
3       1     MAX_LORA_TX_POWER
4       32    pub_key
36      4     lat   int32 LE, degrees * 1e6
40      4     lon   int32 LE, degrees * 1e6
44      1     multi_acks            (v7+)
45      1     advert_loc_policy
46      1     telemetry_mode bits   (v5+)
47      1     manual_add_contacts
48      4     freq  uint32 LE, MHz * 1000   <-- this one
52      4     bw    uint32 LE, kHz * 1000
56      1     sf
57      1     cr
58      ..    node_name, UTF-8 to end of frame
```

Cross-check: `src/selfinfo.js` already reads `pubkey` at `4..36` and `name`
from `58`, which matches this layout exactly. So the offsets are not a guess.

Worked values: `869618` means 869.618 MHz, `433650` means 433.65 MHz.

## What coredrive-rx would need to do

Small, and entirely within `src/selfinfo.js` plus whatever carries the sample:

1. **Extract it.** In `parseSelfInfo`, when `b.length >= 58`, read
   `freq = dv.getUint32(48, true) / 1000` and `bw = dv.getUint32(52, true) / 1000`,
   `sf = b[56]`, `cr = b[57]`. Guard the length: older firmware may send a
   shorter frame, and **absent must stay absent** rather than defaulting — the
   same rule `recv_errors` already follows in `rfstats.js`.
2. **Publish it** in the same shape the fixed observers use, `"freq,bw,sf,cr"`,
   so CoreScope needs no second parser.
3. **Send it per sample or per session, not once per device.** See the caveat
   below; this is the part worth getting right the first time.

Not needed: `STATS_RADIO` (subType 1) carries `noise_floor`, `last_rssi`,
`last_snr`, `tx_air_secs`, `rx_air_secs` and no frequency, so extending that
frame is not the route.

## The caveat that decides the shape

`observers.radio` on the CoreScope side is **current state, not history**. It is
one column, overwritten by each status message. Retune an observer and all of
its past observations silently re-label to the new band.

For a fixed observer that rarely matters — they seldom retune. For a mobile
client it matters a lot: someone can drive one session on 868 and the next on
433, and a device-level field would rewrite the first session's band.

So if this is implemented, the band should travel **with the reception or the
session**, not as a property of the device. Doing it device-level would be
cheaper now and wrong later, and CoreScope would inherit the same flaw it
already has on the fixed side.

## Status

| date | what |
|---|---|
| 2026-09-23 | Investigated. Confirmed the frequency is already in `SELF_INFO` at byte 48 and that `STATS_RADIO` does not carry it. Measured the 4.4% gap. Nothing implemented in this repo. |
| 2026-09-23 | CoreScope side, step 1 built (fork-local): band derived from `observers.radio`, shown as a pill on the observers list. `public/radio-band.js` + `tests/unit/test-radio-band.js`. Covers the 95.6% that fixed observers already report. No server change. |
| 2026-09-23 | coredrive-rx side: corrected "Where coredrive-rx comes in". The 4.4% gap is `kiekr-android` on the observer path, not this app on the client topics. Nothing implemented in this repo. |

## What is NOT decided

- Whether coredrive-rx does this at all. It does not affect the 4.4% (that is
  `kiekr-android`); it only labels this app's own client-table rows. Doing it
  fully touches this repo, the client-table schema in the ingestor and the
  CoreScope UI.
- Whether anyone asks the `kiekr-android` side to publish `radio`, which is
  the only route to the 4.4%.
- Whether the band becomes a per-observation column server-side. That is the
  change that would make band analysis correct over time, for fixed and mobile
  alike, and it has not been designed.
- Anything on the coverage page. `/api/rx-leaderboard` returns no rows on the
  reference deployment because `clientRxCoverage` is off there, so a band column
  on that page would currently decorate an empty table.

Questions or corrections: raise them against this file. The CoreScope side will
keep the Status table current rather than letting this drift.
