# Decision: no hosted relay. The user brings the address.

**Date:** 2026-09-12
**Status:** decided
**Input:** `audit-out/webhook-inbound-2026-09-12.md` — five options judged on the
same five criteria, with a costed budget and the exact PROMISES.md wording a
hosted service would require. That document recommends a hosted inbound service.
**This decision goes the other way, deliberately.**

## What was decided

Cinderpaw will not operate a message relay. Five connectors need an inbound
public address, and we will not provide it. Instead:

1. **Native pull first, always.** Before any platform is called webhook-only,
   its whole API is read, not the connector someone else happened to write.
   That rule alone has already removed two candidates from the list: Nextcloud
   Talk has a user-facing chat API next to its bot webhook, and Zalo's Bot API
   long-polls by default. Six became five became four-plus-Zalo.
2. **For platforms with no pull path, Cinderpaw ships the receiver and the user
   supplies the address.** A separate inbound listener, off unless one of these
   connectors is enabled, serving only connector routes. It never carries
   `/runtime`, the bearer-token API, or anything else on the loopback gateway.
   Signature verification runs on the raw bytes before anything is accepted.
   The user points a tunnel, a reverse proxy or a domain at it. That is their
   infrastructure, on their account, with their bill.
3. **Until that receiver exists, the five stay `coming_soon`** and their cards
   say what they will need, in the description, before anyone tries.

## Why, and what it costs

The recurring cost to Bloom Media is zero. Not "a free tier we hope holds": a
hosted inbox is a bill that arrives every month whether or not a single message
is sent, plus someone on call for it, and this project has no revenue to pay it
from. A service we cannot fund is worse than a connector we did not ship,
because the connector that stops working at 03:00 is one a user was relying on.

It also keeps promise 2 in `PROMISES.md` literally true:

> **2. The runtime does not require a Cinderpaw account or conversation relay.**

The hosted design needed that promise narrowed before launch, and needed a
server-side copy of the LINE channel secret and the Twilio auth token, which
would have to be declared as an exception to promise 5. Neither is dishonest if
it is disclosed — the design says so plainly and prices it. It is simply a
larger thing to take on than the problem justifies. We would be operating
infrastructure that sees users' messages in the clear at TLS termination, in
order to support five platforms, none of which is the one most users arrive for.

**The price is real and it is the user's, so say it out loud.** These five will
never be one-click for someone behind a router. Somebody wanting LINE or Twilio
SMS must run a tunnel or own a domain. That is a worse experience than the
hosted design would give them, and it is the honest trade: we are choosing not
to promise something we cannot keep paying for. The card says so before they
start, rather than after they have pasted a token.

## What this does NOT change

Nextcloud Talk must not be moved onto any shared inbound path, now or later.
Its catalog card says "Nothing goes through anyone else's server." The polling
port keeps that true. A relay would make it false, and it would be false in the
one connector whose entire appeal is that it is self-hosted.

## Revisit when

Cinderpaw has recurring revenue that covers hosting and an on-call rota, or a
platform among the five ships a pull API. Either changes the arithmetic; nothing
else does. `audit-out/webhook-inbound-2026-09-12.md` stays the reference for
what a hosted service would have to contain, so this does not need re-deriving.
