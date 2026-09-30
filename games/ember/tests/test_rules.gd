extends RefCounted

func run(t) -> bool:
	var r := Rules.new()
	t.check("rules: a new fire starts at FIRE_START", r.score() == int(Rules.FIRE_START))
	r.catch_spark()
	t.check("rules: a catch feeds the fire", r.fire == Rules.FIRE_START + Rules.SPARK_FEED)
	r = Rules.new()
	var bonus := false
	for i in Rules.STREAK_LEN:
		bonus = r.catch_spark()
	t.check("rules: the fifth catch in a row is a bonus", bonus and r.fire == Rules.FIRE_START + Rules.STREAK_LEN * Rules.SPARK_FEED + Rules.STREAK_BONUS)
	r.catch_spark()
	r.miss_spark()
	t.check("rules: a missed spark breaks the streak", r.streak == 0)
	r = Rules.new()
	for i in 20:
		r.rain_on_fire()
	t.check("rules: rain never puts the fire out", r.fire == Rules.FIRE_MIN)
	for i in 200:
		r.catch_spark()
	t.check("rules: the fire has a ceiling", r.fire == Rules.FIRE_MAX)
	t.check("rules: bursts differ by kind", r.burst_size("build", 0) > r.burst_size("other", 0))
	t.check("rules: bursts never pass the live cap", r.burst_size("build", Rules.MAX_LIVE_SPARKS - 2) == 2 and r.burst_size("search", Rules.MAX_LIVE_SPARKS + 5) == 0)
	t.check("rules: an unknown kind still gets a small burst", r.burst_size("laser", 0) == 3)
	return true
