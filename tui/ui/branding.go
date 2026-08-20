package ui

import (
	"math/rand"
	"sync"
	"time"
)

// AppName is the product name shown in branding.
const AppName = "FERAL"

// AppVersion is the current release; bumped by release tooling.
const AppVersion = "0.1.0"

// FeralLogo is the ASCII wordmark rendered on the welcome screen.
// Pure ASCII so it survives non-UTF-8 locales (LC_ALL=C etc).
const FeralLogo = `
███████╗███████╗██████╗  █████╗ ██╗     
██╔════╝██╔════╝██╔══██╗██╔══██╗██║     
█████╗  █████╗  ██████╔╝███████║██║     
██╔══╝  ██╔══╝  ██╔══██╗██╔══██║██║     
██║     ███████╗██║  ██║██║  ██║███████╗
╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝
`

// BearLogo is the ASCII bear mascot. The mascot is only used in branding
// surfaces (welcome screen, footer of the finish screen, splash). Other
// surfaces stay glyph-free per the OpenClaw-style UI guidelines.
const BearLogo = `
                                             ==
                                            =--
                                           ===:-   #*%#***:%          +:
                                           =+==-=#%*@%**#%%*%#****   -=--
                                            +*%%%%%@#***%%*%%%%*****=----
                                          #%#%%%@@@%%@%#*%%*%*%#*****==-
                                          #@%@@@*+====*%%%@@+%@%%%*#***:
                                         *%%%@+=========-----::::-@%*#*#*
                                        %#%@@+==%@:+======----::::-%%%%**
                                        #%%%@+=+%@@=========--@* =--@@***=
                                        *%%@%#+==+==@@=====:.-%%%---%@***
                                        %%%@@%@**+++++=-==@%===-=--=@%*%*
                                       %@%%@%%%%%%@%#**+++========*%#%@#*
                                     #%@@@*%##@@#@%%%*%%*%%*#**%###*@#%*
                                    *%#@#%#*@%#@@@@%%@%@%#@%%**%#@*%%%%%#
                                    ##%@%%*%#@%@@@@%@%@%%@*%%%%#%%#%%%%#**
                                   .*%#@##%#@@@@@@@@%%%%%%%%%@%@@%%@%@@%***
                                    #%%%%%%@@@@@@@%%*=====-:--=@%#%#%@%%@**
                                         *@%@@@@@%@+=====---::--=%*#%@@%#%*#
                                        .*%%%%@%%%+=========-----@%%%@@@%%#+
                                         *%%%%%%%#++=========----@%%% %**#*
                                          %%%%%%%@+==========----@%% %%@%#
                                          #%%%%%%%*============-%%##  *%#
                                           *#@%%%%%%+==========%%%#
                                            *@%%%@%@%%%%%@%%%%%%%#
                                              %%@%%@@@+%*%@@@@@%%*
                                              #%%%%%%@:  %@@@@@%=%**
                                             %%%%%#%%#      %@%%%%.
` + AppName + ` v` + AppVersion + ` | Own your agent`

// BearCompact is a one-line bear for narrow terminals and the finish footer.
const BearCompact = `(=-._.=) ` + AppName + ` v` + AppVersion + ` | Own your agent`

// Taglines are short, rotating brand messages shown on the welcome screen.
// A random pick per launch gives the welcome screen a bit of personality
// without being noisy.
var Taglines = []string{
	"Own your models. Own your agent.",
	"Local-first. BYOK. No lock-in.",
	"Run AI on your machine. Keep your keys.",
	"Private by default. Powerful on demand.",
	"Your models. Your data. Your rules.",
	"Bears don't leak. Neither does Cinderpaw.",
}

// taglineMu guards the random source. math/rand's global is fine for
// non-crypto use, but seeding once at startup is cleaner.
var (
	taglineMu  sync.Mutex
	taglineRng = rand.New(rand.NewSource(time.Now().UnixNano()))
)

// RandomTagline returns a random tagline from Taglines.
func RandomTagline() string {
	taglineMu.Lock()
	defer taglineMu.Unlock()
	return Taglines[taglineRng.Intn(len(Taglines))]
}
