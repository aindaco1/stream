# Stream roadmap

## Live in the hosted pilot

The November 26, 2026 release (UTC) added filmmaker-managed coupons, separate SRT tracks and rental watermark lookup. [Stream release PR](https://github.com/aindaco1/stream/pull/42)

| Shipped | What a filmmaker or viewer can do |
| --- | --- |
| Coupons | Limit a code to one film or program, one kind of offer, a date or a number of uses. A 100% code grants the usual rental or purchase. We confirmed both in Stripe’s sandbox, including recovery and the purchase download entitlement. [Coupon FAQ](https://streamyourfilm.com/faq#coupons) |
| Uploaded subtitles | Offer multiple tracks in the same language alongside embedded captions, including separate dialogue and SDH tracks. [Subtitle FAQ](https://streamyourfilm.com/faq#subtitles) |
| Optional rental watermark | Show an eight-character order code inside the picture. Support can trace it in **Platform analytics → Rental watermark lookup**. Local crop and re-encode tests recovered the code from square and 4:3 footage. [Renderer and lookup tests](docs/rental-copy-protection-plan.md#2-trace-a-watermarked-rental) |

**Next playback check.** Match the code from a team-controlled hosted rental to its checkout in super-admin. Check a preview, an unmarked rental and a purchase alongside it. Verify caption selection, sync after a seek and watermark legibility on the physical receivers listed below.

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

Run one marked two-film program on a Roku Ultra over AirPlay and on a Chromecast or Google TV device over Cast. Start on the phone, seek, change titles, return to a title with both ordinary subtitles and SDH, switch tracks, disconnect and resume. Read the watermark and captions on the television itself. Confirm the viewer keeps the same rental and that expired access stops further playback. Publish a short compatibility table in the filmmaker FAQ with the receiver model, sender browser, and observed result.

**Then decide whether viewers need an installable TV app.** Ask pilot filmmakers which devices their audiences use and where handoff fails. Choose one platform for a prototype. The first useful app lets someone open an existing rental on the couch, resume the correct program title, select captions with the remote, and see when access expires. Reuse Stream's order, program edition and media authorization. Check platform rules and the effect on filmmaker payouts before committing to a storefront.

| Candidate | First decision |
| --- | --- |
| Roku | Verify how Stream's filmmaker-owned checkout fits certification. Roku requires Roku Pay for transactional apps and on-device authentication. An off-device activation code alone would not meet its published requirements. AirPlay-to-Roku can be tested independently. [Roku certification criteria](https://developer.roku.com/dev/docs/certification) |
| Apple TV | Evaluate a tvOS app for viewers who already rented on a filmmaker's site. Verify the proposed access flow under the video reader-app rules, then test remote navigation, subtitles and resume on Apple TV hardware. [App Review Guidelines, section 3.1.3(a)](https://developer.apple.com/app-store/review/guidelines/#reader-apps) |
| Android TV / Google TV | If Cast testing reveals demand for watching without a phone, prototype a remote-first player on one supported device. Track Fire TV, Samsung Tizen and LG webOS as separate candidates as device requests come in. [Android TV design and development](https://developer.android.com/tv) |

## Other candidates for the pilot

| Viewer or filmmaker need | Smallest useful next step |
| --- | --- |
| A faster first visit to Dashboard and Settings | Dashboard and Settings now run beside their SQLite data. In a signed-in Helium check with the media container idle, controls appeared in 1.24 seconds going to Settings and 1.28 seconds returning to Dashboard. Repeat from a fresh sign-in and record Worker and SQLite operations across several visits. [Dashboard release](https://github.com/aindaco1/stream/pull/39) |
| Reliable playback on cellular and accessible checkout | Time first frame, seeking and program transitions on a physical phone with a feature-length film. Exercise the actual payment fields, error recovery and captions with VoiceOver and TalkBack. Fix the first reproducible point where a viewer gets stuck. [Web audit](docs/web-audit-2026-11-21.md#priorities-before-a-public-release) |
| Private invitations for press and festival programmers | A one-use, 100% rental coupon already covers a complimentary screening. If filmmakers need to withdraw access after redemption, trial a revocable invitation for one title. Reuse playback authorization and the optional watermark. Keep complimentary access distinguishable from paid orders in support and sales reports. |
