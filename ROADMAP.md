# Stream roadmap

November 25, 2026

## Recommended next release

**Ship the optional rental watermark improvements and the super-admin lookup together.** A filmmaker can send a screener, and support can trace a code found in a reported copy. Both pieces are implemented and tested locally. Production verification is pending.

- **What the viewer sees.** When a filmmaker enables the existing watermark, the rental offer explains it before payment. An eight-character rental code appears for four seconds each minute, moving between four interior positions. Only the code appears on screen. It remained readable when square and 4:3 test footage was cropped to widescreen, resized by half and re-encoded. A clip taken between appearances can miss it.
- **What support sees.** In **Platform analytics → Rental watermark lookup**, a super-admin enters the code to find the title, payment and associated customer email. Older codes remain traceable. If two rentals share a code, support sees the candidate payments and can review the title and date. A match identifies the order associated with the footage. It does not establish who shared it.
- **What it costs.** The code goes into the existing rental-order write. An explicit lookup can index older orders in batches and consult Stripe for the contact on a unique match. Playback adds no Worker or Durable Object reads or writes for the lookup. The renderer uses the existing marked intervals.

**Release check.** Deploy the workspace Worker and media runtime from the same revision. Use a team-controlled rental on the hosted service to match the code seen in the picture to the expected payment. Check a clean preview, an unmarked rental and a purchase. On a TV, read the code with captions on and check that both remain legible. Record which device passed. [Cloudflare deployment](docs/origin-cloudflare.md) · [Rental research and test results](docs/rental-copy-protection-plan.md)

## Download protection decisions

| Decision | Evidence and next action |
| --- | --- |
| Keep ordinary rentals on the current encrypted HLS path | Originals stay private and original-file downloads require a purchase. In the sandbox, Dust Wave Downloader saved the paid viewing copy, including the mark when enabled. Stock yt-dlp failed on the public rental embed and saved an intentionally accessible AES-128 HLS control. Rotating keys still gives an authorized player the keys needed for playback. [Test cases](docs/rental-copy-protection-plan.md) · [HLS specification](https://datatracker.ietf.org/doc/html/rfc8216#section-6.3.6) |
| Keep download pacing out of production | Both settings tested still allowed a complete save. On a 90-minute rental, three ordinary seeks took 3.48–4.86 seconds with the larger allowance and 0.26–0.42 seconds without it. Revisit only if a new approach can distinguish bulk saving while preserving seeking and TV handoff. [Pacing trials](docs/rental-copy-protection-plan.md#3-test-the-proposed-download-slowdown) |
| Make Dust Wave Downloader honor Stream rentals in its own release | Use the Stream player's existing rental state to show “Playback only” for that player and decline a save. Test a rental beside a preview, the public demo and a purchased download. This costs no extra Worker calls. Keep an independent downloader in the sandbox test because other tools can ignore the signal. [Player implementation](public/app.js) |
| Offer a stronger screener if filmmakers need it | Try an optional 540p ceiling in the existing marked render and judge the result on a TV. If short or cropped leaks repeatedly defeat visible codes, evaluate forensic watermark recovery offline. Signal's capture protection relies on native app controls that a web embed cannot set. [Open-source watermark, player and capture research](docs/rental-copy-protection-plan.md#open-source-projects-worth-borrowing-from) |
| Evaluate DRM if a distributor requires blocking ordinary downloaders | Estimate packaging, license delivery and device support before committing. Widevine's direct cloud service has no access or transaction fees and requires an agreement and a license proxy. Apple's FairPlay requires production approval and key delivery. [Widevine](https://developers.google.com/widevine/drm/overview) · [FairPlay](https://developer.apple.com/streaming/fps/) |

## Watching on a TV

**First, establish which TVs play a rental from the existing embed.** Stream already offers Safari AirPlay, a browser TV picker where supported, and a private rental link for handoff. The receiver uses an expiring playback lease. An earlier rehearsal reported Safari advancing a paid rental on a physical Roku Ultra. Physical Google Cast output and the appearance of captions and the revised watermark on the TV still need confirmation. [Player handoff](public/airplay.js) · [Receiver rehearsal](https://github.com/aindaco1/stream/pull/23) · [Google Cast media support](https://developers.google.com/cast/docs/media)

Run one marked two-film program on a Roku Ultra over AirPlay and on a Chromecast or Google TV device over Cast. Start on the phone, seek, change titles, return to a captioned title, disconnect and resume. Read the watermark and captions on the television itself. Confirm the viewer keeps the same rental and that expired access stops further playback. Publish a short compatibility table in the filmmaker FAQ with the receiver model, sender browser, and observed result.

**Then decide whether viewers need an installable TV app.** Ask pilot filmmakers which devices their audiences use and where handoff fails. Choose one platform for a prototype. The first useful app lets someone open an existing rental on the couch, resume the correct program title, select captions with the remote, and see when access expires. Reuse Stream's order, program edition and media authorization. Check platform rules and the effect on filmmaker payouts before committing to a storefront.

| Candidate | First decision |
| --- | --- |
| Roku | Verify how Stream's filmmaker-owned checkout fits certification. Roku requires Roku Pay for transactional apps and on-device authentication. An off-device activation code alone would not meet its published requirements. AirPlay-to-Roku can be tested independently. [Roku certification criteria](https://developer.roku.com/dev/docs/certification) |
| Apple TV | Evaluate a tvOS app for viewers who already rented on a filmmaker's site. Verify the proposed access flow under the video reader-app rules, then test remote navigation, subtitles and resume on Apple TV hardware. [App Review Guidelines, section 3.1.3(a)](https://developer.apple.com/app-store/review/guidelines/#reader-apps) |
| Android TV / Google TV | If Cast testing reveals demand for watching without a phone, prototype a remote-first player on one supported device. Track Fire TV, Samsung Tizen and LG webOS as separate candidates as device requests come in. [Android TV design and development](https://developer.android.com/tv) |

## Other candidates for the pilot

| Viewer or filmmaker need | Smallest useful next step |
| --- | --- |
| A faster first visit to Dashboard and Settings | Measure first sign-in and the first round trip between both pages on a production filmmaker account. Record page timings and Worker/SQLite reads and writes. Change a repeated query only when a matched before-and-after run shows a benefit. |
| Reliable playback on cellular and accessible checkout | Time first frame, seeking and program transitions on a physical phone with a feature-length film. Exercise the actual payment fields, error recovery and captions with VoiceOver and TalkBack. Fix the first reproducible point where a viewer gets stuck. [Web audit](docs/web-audit-2026-11-21.md#priorities-before-a-public-release) |
| Captions for films with no embedded track | SRT uploads and multiple tracks per language are implemented locally. Verify sync and switching between subtitles and SDH on physical TV receivers after seeking. |
| Private invitations for press and festival programmers | If filmmakers are issuing one-off access manually, trial a revocable invitation to one film or program with an expiry. Reuse playback authorization and the optional watermark. Keep complimentary access distinguishable from paid orders in support and sales reports. |
