# Rental copy protection

**Hosted release, November 26, 2026 (UTC).** Filmmakers can enable **Rental screener watermark** on a film or program. The player moves the code inside the picture, and a super-admin can look up the associated rental. This uses the existing media renderer with no recurring DRM fee. Download pacing remains an experiment because it delayed ordinary seeks. [Release and remaining checks](../ROADMAP.md#live-in-the-hosted-pilot)

## What Stream already protects

Originals live in the filmmaker’s private storage. A rental grants time-limited HLS playback. A purchase can authorize an original download. Playback grants last up to ten minutes, capped by the entitlement, and TV playback has its own expiring receiver lease. A paid viewer still receives enough information to play the encrypted video. yt-dlp documents support for AES-128 HLS. Dust Wave Downloader 0.1.19 saved the paid HLS viewing copy in the sandbox test below. The public-domain homepage MP4 is intentionally downloadable and would give a misleading result. [Rental authority](../src/rental.js) · [Media routes](../src/server.js) · [TV leases](../src/airplay.js) · [yt-dlp](https://github.com/yt-dlp/yt-dlp)

A browser player cannot reliably detect another app recording the display. The web Screen Capture permission controls whether a document can *request* capture. Device-backed DRM can suppress capture on some playback paths. A camera pointed at the screen can still record the picture. For Stream, the practical defense against recording is a mark that travels with the image and can be investigated later. [W3C Screen Capture](https://www.w3.org/TR/screen-capture/) · [Apple’s documented FairPlay capture behavior](https://developer.apple.com/library/archive/qa/qa1970/)

## 1. Measure a real rental first

**Local baseline, November 25, 2026.** Stock yt-dlp 2026.11.23 received the public URL of a rental-enabled Stream embed serving a synthetic clock. It reported an unsupported URL and produced no file. As a separate format check, we deliberately made an AES-128 HLS rendition of the same clock accessible on localhost. yt-dlp saved the entire 136-second video in 1.63 seconds, and both audio and video decoded. The latter measures format support on loopback. This yt-dlp run did not exercise a paid viewer session.

**Dust Wave Downloader acceptance, November 25, 2026.** Tested the unmodified iCloud Drive build of Dust Wave Downloader 0.1.19 (repository commit `fb11661`) in disposable Helium 0.22.4.1 profiles on macOS. The live public homepage and the local rental test used different players. The local test used Stream’s published-film player, encrypted media routes and sandbox checkout rehearsal with a simulated payment provider.

| Case | Observed in the extension | Verified output |
| --- | --- | --- |
| Live Market Street homepage after test rental | Two file choices matching the screenshot | Both silent MP4s saved and decoded. Their hashes matched the public 10-second preview and the 9:39 film exactly. |
| Cross-site rental embed before simulated payment | Only the 10-second preview appeared | No full-length option appeared. |
| Standard rental after simulated payment | An additional 2:16 HLS choice appeared | Download saved the complete 136-second MP4 in 15.8 s on loopback. H.264 video and AAC audio decoded to the end. |
| Watermarked rental after simulated payment | The same 2:16 HLS choice appeared | Download saved the complete MP4 in 21.3 s. The expected eight-character order reference was visible at 0:02 in the upper right and 1:02 in the upper left. |

The original-file control stayed hidden and neither paid download hit the original-file route. Both saved viewing copies were readable after the local server stopped. These are single-run download times for a synthetic 320 × 180 clip. Production throughput, feature-length behavior, Video DownloadHelper and yt-dlp in a paid session are still unmeasured.

**Budget half a day.** Use a team-owned, timecoded hour-long fixture and a two-title program in the sandbox. Issue two rentals and a purchase. On stock Chrome, try Video DownloadHelper’s normal save action. Exercise yt-dlp as a separate compatibility case. Record whether either tool detects the title, produces a playable file, how much of the film it contains, and elapsed time. Record a marked and an unmarked rental with an OS recorder. Include the app, OS and version in the results. A detected stream alone counts as detection. [Video DownloadHelper’s stated DRM boundary](https://help.downloadhelper.net/article/14-what-can-i-do-if-the-video-is-protected-by-drm)

In the same run, measure time to first frame, stalls, seek recovery, media CPU time, storage reads and Worker/DO calls for ordinary viewing. Include the fastest supported playback speed, repeat seeks, reconnects, captions, a program title change and a real Safari-to-TV handoff. Check that expired or revoked rentals cannot fetch new protected media, a rental cannot download the original or ZIP, and a purchase still can. Reuse the [checkout rehearsal](../scripts/check-viewer-checkout.js), [download authorization tests](../test/viewer-server.test.js) and [AirPlay tests](../test/airplay.test.js).

## 2. Trace a watermarked rental

The optional screener mark still burns the existing eight-character rental code into the picture for four seconds each minute. A viewer sees an explanation before renting. The mark moves between four interior positions, sized and positioned within the overlap of centered square and widescreen crops. A darker backing improves contrast on pale scenes. The cadence, subtitle path, sharing of quiet segments and number of personalized renders are unchanged. An excerpt entirely between marks, an obscured code or a severe off-center crop can still prevent identification. [Reference generation](../src/rental-reference.js) · [Rendering and cache behavior](../src/media.js) · [Mark placement](../src/media-compat.js)

On **Platform analytics → Rental watermark lookup**, a super-admin enters the visible code. A unique match shows the title, filmmaker, payment reference, date and Stripe checkout email. If the session has no email, Stream checks the billing email on the associated charge. Stream stores the code in the existing rental-order insert and indexes settled rentals. Older codes use the same calculation and are indexed in batches of up to 100 on a lookup. Opening the dashboard and playing a segment add no storage queries for this feature. Only an explicit super-admin lookup reads customer information from Stripe. Multiple matches list the payments for human review. A code identifies the associated rental. It cannot establish who recorded the footage.

**Crop test, November 25.** Rendered a known code on white square, black 4:3 and gray 16:9 fixtures. Center-cropped square and 4:3 to 16:9 and widescreen to square, halved both output dimensions, and re-encoded with H.264 at CRF 24. At both 0:02 and 1:02 the complete code could be recovered in all three outputs. Full-frame OCR read three of six frames automatically. Selecting and enlarging the visible label let OCR read all six exactly. A separate comparison using frames from the public Market Street film shows the code above-right and below-left after cropping a square source to 320 × 180.

## 3. Test the proposed download slowdown

**Decision.** Leave pacing out of production. The more restrictive allowance delayed real seeks. Doubling the burst reduced the impact, but still delayed a legitimate buffer request. On a feature-length fixture the larger burst also delayed ordinary seeks by several seconds. The pilot required zero interventions in normal viewing.

On localhost, the experimental allowance charged each new segment’s duration once per trial. Duplicate requests shared the same eligibility time. Segments could arrive immediately up to a burst allowance and then at a fixed number of media seconds per wall-clock second. Scheduling happened in process memory. All trials used synthetic films and disposable browser profiles.

| Test | Unpaced | 36 s burst, 1.98× refill | 72 s burst, 1.96× refill |
| --- | ---: | ---: | ---: |
| Dust Wave Downloader 0.1.19, complete 136 s public clock | 2.88 s | 50.72 s | 32.66 s |
| Sandbox rental, 2× playback, seek to 0:54 | 0.54 s | 0.17 s | 0.26 s |
| Seek to 1:44 | 1.08 s | 3.80 s | 0.26 s |
| Seek back to 0:30 | 1.31 s | 4.75 s | 0.26 s |

The extension saved the same 34-segment H.264/AAC public HLS control in each trial. Each saved file decoded through 136 seconds. The seek trials used the normal encrypted rental player after simulated checkout in Helium. Seek times measure the interval from moving the playhead to confirmed playback past the target. With the 72-second allowance, the three seeks resumed promptly, but the player’s following buffer request was held for 1.29 seconds. These are individual loopback runs with different cache warmth. Production p95 remains unmeasured.

**Feature-length cross-check.** In Chromium, an uninterrupted 16-second sample of normal-speed rental viewing had zero buffer waits or delayed requests with the 36-second allowance. For the 72-second allowance we made six seeks at 2× across a 90-minute synthetic rental, using the same six destinations in the unpaced control. The first three resumed in 0.31–0.37 s in both runs. The final three took 0.31, 0.42 and 0.26 s unpaced and 3.48, 4.86 and 4.71 s with pacing. Each of those seek requests incurred roughly 2.9 s of scheduled delay before media work.

Both candidate settings were chosen to model a 30-minute minimum for a fresh, uninterrupted hour-long transfer. Subtract the burst from 3,600 media seconds and divide by the refill rate to get the modeled duration. An hour-long save was not timed. Sustained playback, remote-device buffering and seeking can all consume the same allowance. Saturating the budget does not distinguish a downloader from a paying viewer. Production load, distributed state and physical TV playback were outside the trial.

## Open-source projects worth borrowing from

**Signal’s screen security needs a native window.** Signal’s November 20, 2026 mobile rollout blocks screenshots and screen recordings of its app while protection is enabled. Its AGPL-3.0-only Android code sets the operating system’s secure-window flag. Its iOS code applies UIKit’s secure-text redaction to a view’s drawing layer and explicitly depends on text-field internals. Stream’s iframe owns neither native surface. The browser’s `display-capture` permission governs requests to start a capture. It gives an embedded film no corresponding veto over an outside recorder. These display controls also leave HLS delivery to an authorized viewer untouched. Revisit the Android flag if Stream gains a native screener app for another reason, and verify capture and TV playback together on physical devices. [Signal’s announcement](https://signal.org/blog/protecting-your-privacy/) · [Android implementation](https://github.com/signalapp/Signal-Android/blob/2dd57038758b7630c028dcfd5eaf4e27acc0b11a/core/ui/src/main/java/org/signal/core/ui/WindowExtensions.kt#L20-L27) · [iOS implementation](https://github.com/signalapp/Signal-iOS/blob/45372289a9387cd4271a2f7a47dba8ba92951e41/Signal/Screenshots/ScreenshotBlocking.swift#L9-L46) · [Signal support](https://support.signal.org/hc/en-us/articles/11338514641306-Screen-security-blocking-Google-Gemini-and-Siri-AI) · [Web capture permissions](https://www.w3.org/TR/screen-capture/#permissions-policy-integration)

| Project | What it contributes to this decision |
| --- | --- |
| [PeerTube private media](https://docs.joinpeertube.org/api-rest-reference/api/static-video-files.html) | PeerTube requires authorization for private HLS files. Stream already grants expiring playback and separately authorizes original downloads. Use these as regression checks across playlist, key, media and download routes. A second token scheme would duplicate existing work. |
| [NGINX request limiting](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html) | Its dry-run mode and burst allowance are a model for testing a sustained bulk-download slowdown. Measure media time delivered per rental because connection counts alone do not measure how much of a film was served. |
| [watermark-service](https://github.com/rtagliaviaz/watermark-service) | An MIT-licensed reference implementation for identifying a session through a sequence of A/B video segments. Its author documents limitations with cropping and resizing. Consider an offline comparison only if short or cropped leaks repeatedly defeat the visible reference. |
| [Meta VideoSeal](https://github.com/facebookresearch/videoseal) | An open-source invisible watermark encoder, detector and evaluation suite. Borrow its test idea now: evaluate both recovery after transformations and picture quality. A model in Stream’s playback path would add a new compute burden. |
| [Shaka Packager](https://github.com/shaka-project/shaka-packager) | An open-source reference for HLS/DASH packaging and encryption. Stronger device-backed playback also needs a supported key system, license delivery and device testing. Revisit this path if a distributor requires DRM or if blocking ordinary downloaders becomes a release requirement. [Apple FairPlay Streaming](https://developer.apple.com/streaming/fps/) |

**Release acceptance.** Review a marked screener on an actual TV with captions and check a known rental in the deployed super-admin UI before using the lookup for support. Revisit pacing if new measurements can separate sustained fetching from ordinary seeking without delaying viewers.
