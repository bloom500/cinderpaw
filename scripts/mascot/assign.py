"""Every illustration in the pack, assigned to the state it actually describes.

The pack is 75 scenes around one body. Our app has 22 states. So a state's
VARIETY stops coming from redrawing the creature and starts coming from what
stands next to it -- which is how the pack was composed in the first place.
"""
import io, json, collections

ASSIGN = {
    # the agent is working
    'calling': ['multi-window-workflow', 'api-success-pixel', 'server-stack-pixel',
                'infrastructure-server-stacks', 'managing-server-rack', 'data-blocks-pixel',
                'processing-logic-symbols', 'system-monitoring-dashboard'],
    'building': ['building-colorful-blocks', 'repairing-with-tools', 'planting-small-trees',
                 'lab-science-testing', 'growing-pixel-nature'],
    'writing':  ['writing-software-code', 'professional-documentation-audit', 'baking-steaming-pie'],
    'reading':  ['reading-data-document', 'reviewing-long-data-log', 'holding-ancient-scroll',
                 'visualizing-tree-data'],
    'searching': ['examining-green-globe', 'tracking-multiple-locations', 'debugging-system-bugs',
                  'malware-detection-window', 'stealth-ninja-security', 'secure-access-padlock'],
    'thinking': ['thinking-in-code', 'thinking-pixel-bubble', 'it-depends-sign',
                 'in-constant-loop', 'user-profile-settings'],
    'running':  ['fast-performance-trail', 'refresh-sync-pixel', 'lifting-heavy-barbell'],

    # the turn ended
    'done':      ['with-success-checkmark', 'success-achievement-milestone', 'trending-up-pixel'],
    'celebrate': ['happy-pixel-celebrating', 'rocket-launch-success'],
    'excited':   ['idea-lightbulb-pixel', 'in-glowing-aura', 'angry-powerful-lightning'],

    # something went wrong
    'error': ['system-error-alert', 'error-state-pixel', 'marking-critical-error',
              'failed-process-error', 'dizzy-failed-state', 'angry-at-laptop',
              'angry-pixel-coffee', 'fine-under-pressure'],

    # the person
    'love':      ['love-cloud-pixel', 'holding-green-leaf', 'nature-growth-mushrooms'],
    'wave':      ['welcome-pixel-banner', 'developer-pair-programming-scene'],
    'curious':   ['confusion-spiral-pixel'],
    'sleep':     ['sleeping-soundly', 'disconnected-plug-pixel'],
    'surprised': ['broken-heart-sad', 'crying-sad-reaction'],

    # nobody asked for anything yet
    #
    # These three are the states a stranger sees MOST -- `idle` is every second
    # the app is open, `typing` is every second they spend writing, and
    # `stretching` is what a poke or a drop lands on -- and they were the three
    # left with an empty margin. A scene here is not decoration, it is the
    # difference between a creature in a room and a sprite on a background.
    #
    # Small and still, on purpose: `idle` is permanent furniture, so it gets the
    # 13x6 plant rather than one of the 200-cell machines.
    'idle':       ['planting-small-trees'],
    'typing':     ['artboard-25cla'],
    'stretching': ['lifting-heavy-barbell'],
}

props = json.loads(io.open('props.json', encoding='utf-8').read())
ref = json.loads(io.open('refpack.json', encoding='utf-8').read())

used = {n for v in ASSIGN.values() for n in v}
missing = sorted(set(ref) - used)
unknown = sorted(used - set(ref))
noscene = sorted(n for n in used if n in props and len(props[n]['scene']) < 12)

print('illustrations assigned : %d of %d' % (len(used), len(ref)))
print('states covered         : %d' % len(ASSIGN))
if unknown:
    print('NAMED BUT NOT IN PACK  : %s' % unknown)
print()
print('not assigned (%d):' % len(missing))
for n in missing:
    cells = len(props[n]['scene']) if n in props else 0
    print('   %-38s %4d scene cells' % (n, cells))
print()
if noscene:
    print('assigned but almost no scene: %s' % noscene)
print()
print('scenes per state:')
for s, v in sorted(ASSIGN.items(), key=lambda kv: -len(kv[1])):
    print('   %-11s %d' % (s, len(v)))
io.open('assign.json', 'w', encoding='utf-8').write(json.dumps(ASSIGN, separators=(',', ':')))
