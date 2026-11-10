# Play Console: Data safety answers

Draft answers for the Data safety form, derived from the code on `feat/android-capacitor`
(src/publisher.js payloads, src/account.js, src/localmap.js, the merged AndroidManifest). Check
against the form's current wording when filling it in.

## Data collection and security

| Question | Answer | Why |
|---|---|---|
| Does your app collect or share any of the required user data types? | Yes | Location, IDs, email (login) |
| Is all of the user data collected by your app encrypted in transit? | Yes | HTTPS and MQTT over TLS (wss) only |
| Do you provide a way for users to request that their data is deleted? | Yes | By email to the deployment operator, see privacy policy |

## Data types

"Shared" is No throughout: Play counts a transfer that the user starts as not shared, and the
user chooses the deployment that receives the data. Revisit this if the default changes.

| Data type | Collected | Shared | Optional? | Purposes | Notes |
|---|---|---|---|---|---|
| Location: precise location | Yes | No | Required | App functionality | Every reception, RF sample, region answer and uplink ping carries lat/lon/accuracy |
| Location: approximate location | No | | | | Only precise is used |
| Personal info: email address | Yes | No | Optional | Account management | Sent once at CoreScope login; only the token is kept |
| Device or other IDs | Yes | No | Required | App functionality | The companion radio's public key and name identify the recorder |
| Messages: other in-app messages | Decide | No | Required | App functionality | Raw received packets can carry other people's (encrypted) mesh messages. Not messages of the user of this app; see open question below |
| App activity, web browsing, financial, health, contacts, photos, audio, files, calendar | No | | | | |
| App info and performance: crash logs, diagnostics | No | | | | The debug log leaves the phone only through the user's own share action |

## Open question

Whether raw MeshCore packets count as "other in-app messages". They are radio traffic the
companion receives, not content the user writes, and the app does not decrypt private messages.
Declaring them is the cautious choice; it costs nothing beyond a line in the listing.
