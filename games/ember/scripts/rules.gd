class_name Rules
extends RefCounted
## The campfire's arithmetic, with no nodes and no drawing, so a test can play
## a whole round in a loop. The fire is the score.

const FIRE_START := 10.0
const FIRE_MIN := 4.0
const FIRE_MAX := 100.0
const SPARK_FEED := 2.0
const RAIN_DOUSE := 3.0
const STREAK_BONUS := 8.0
const STREAK_LEN := 5
## A flood of tool calls must not flood the screen.
const MAX_LIVE_SPARKS := 40
const BURST := {"search": 5, "read": 4, "build": 6, "other": 3}

var fire := FIRE_START
var streak := 0
var caught := 0

func burst_size(kind: String, live: int) -> int:
	return clampi(BURST.get(kind, 3), 0, maxi(0, MAX_LIVE_SPARKS - live))

## Returns true when this catch completed a streak (the big flame).
func catch_spark() -> bool:
	caught += 1
	streak += 1
	fire = minf(FIRE_MAX, fire + SPARK_FEED)
	if streak % STREAK_LEN == 0:
		fire = minf(FIRE_MAX, fire + STREAK_BONUS)
		return true
	return false

func miss_spark() -> void:
	streak = 0

func rain_on_fire() -> void:
	fire = maxf(FIRE_MIN, fire - RAIN_DOUSE)

func score() -> int:
	return int(round(fire))
