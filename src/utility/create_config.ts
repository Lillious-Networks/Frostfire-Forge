import path from "path";
import fs from "fs";

const configPath = path.join("config");
if (!fs.existsSync(configPath)) {
  fs.mkdirSync(configPath);
}

const assetConfig = {
  maps: {
    path: "../../assets/maps/",
  },
  tilesets: {
    path: "../../assets/tilesets/",
  },
  sfx: {
    path: "../../assets/sfx/",
  },
  spritesheets: {
    path: "../../assets/spritesheets/",
  },
  sprites: {
    path: "../../assets/sprites/",
  },
  animations: {
    path: "../../assets/animations/",
  },
  icons: {
    path: "../../assets/icons/",
  }
};

const settings = {
  "logging": {
    "level": "trace",
  },
  "2fa": {
    "enabled": false,
  },
  "webserverRatelimit": {
    "enabled": true,
    "windowMs": 5,
    "max": 500
  },
  "websocketRatelimit": {
    "enabled": true,
    "maxRequests": 2000,
    "time": 2000,
    "maxWindowTime": 1000
  },
  "websocket": {
    "maxPayloadMB": 50,
    "benchmarkenabled": false,
    "idleTimeout": 5
  },
  "world": "default",
  "default_map": "main"
};

if (!fs.existsSync(path.join(configPath, "assets.json"))) {
  fs.writeFileSync(
    path.join(configPath, "assets.json"),
    JSON.stringify(assetConfig, null, 2)
  );
  console.log(`Created assets config file at ${path.join(configPath, "assets.json")}`);
} else {
  console.log(`Assets config file loaded from ${path.join(configPath, "assets.json")}`);
}

if (!fs.existsSync(path.join(configPath, "settings.json"))) {
  fs.writeFileSync(
    path.join(configPath, "settings.json"),
    JSON.stringify(settings, null, 2)
  );
  console.log(`Created settings file at ${path.join(configPath, "settings.json")}`);
} else {
  console.log(`Settings loaded from ${path.join(configPath, "settings.json")}`);
}

const swears = [
  {
    "id": "1man1jar",
    "match": "1m1j|1man1jar|1 man 1 jar|one man one jar|one jar one man",
    "tags": [
      "shock"
    ],
    "severity": 4
  },
  {
    "id": "2girls1cup",
    "match": "2g1c|2girls1cup|2 girls 1 cup|two girls one cup|one cup two girls",
    "tags": [
      "shock"
    ],
    "severity": 4
  },
  {
    "id": "acrotomophilia",
    "match": "acrotomophilia|acrotomophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "adjective-cock",
    "match": "black cock|big cock|huge cock|giant cock|massive cock|throbbing cock",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "alabama-hot-pocket",
    "match": "alabama hot pocket",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "alabama-tuna-melt",
    "match": "alabama tuna melt",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "alaskan-pipeline",
    "match": "alaskan pipeline",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "algophilia",
    "match": "algophilia|algophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "anal",
    "match": "anal",
    "tags": [
      "sexual"
    ],
    "severity": 2
  },
  {
    "id": "anal-assassin",
    "match": "anal assassin",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "anal-astronaut",
    "match": "anal astronaut",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "anilingus",
    "match": "anilingus",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "anus",
    "match": "anus",
    "tags": [
      "sexual"
    ],
    "severity": 1,
    "exceptions": [
      "m*",
      "m*cript",
      "m*cripts",
      "pand*",
      "pand*es",
      "tet*",
      "tet*es"
    ]
  },
  {
    "id": "apeshit",
    "match": "apeshit|ape-shit|ape shit",
    "tags": [
      "general"
    ],
    "severity": 2
  },
  {
    "id": "apotemnophilia",
    "match": "apotemnophilia|apotemnophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "arse",
    "match": "arse",
    "tags": [
      "sexual"
    ],
    "severity": 2,
    "exceptions": [
      "*n",
      "cath*",
      "co*",
      "he*",
      "ho*",
      "kath*",
      "m*illes",
      "p*",
      "s*n"
    ]
  },
  {
    "id": "arsehole",
    "match": "arseho*le|ass*ho*le",
    "tags": [
      "general"
    ],
    "severity": 3
  },
  {
    "id": "ass",
    "match": "ass",
    "tags": [
      "sexual"
    ],
    "severity": 1
  },
  {
    "id": "ass-bandit",
    "match": "ass bandit|arse bandit",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "autoerotic|auto erotic",
    "match": "autoerotic|auto erotic",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "babeland",
    "match": "babeland",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "baby-batter",
    "match": "baby batter|baby gravy|baby juice|ball batter|ball gravy",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "ball-gag",
    "match": "ball gag|ball-gag|ballgag",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "ball-kicking",
    "match": "ball kicking|ball-kicking",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "ball-licking",
    "match": "ball licking|ball-licking",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "ball-sack",
    "match": "ball sack",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "ball-sucking",
    "match": "ball sucking|ball-sucking",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "ballcuzi",
    "match": "ballcuzi",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "bangbros",
    "match": "bangbros|bang bros",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "bangbus",
    "match": "bangbus|bang bus",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "bareback",
    "match": "bareback",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "barely-legal",
    "match": "barely legal",
    "tags": [
      "sexual"
    ],
    "severity": 4
  },
  {
    "id": "bastard",
    "match": "ba*sta*rd",
    "tags": [
      "general"
    ],
    "severity": 3
  },
  {
    "id": "bastinado",
    "match": "bastinado",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "batty-boy",
    "match": "batty boy|battyboy|batty boi|battyboi",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "bdsm",
    "match": "bdsm",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "bean-flicker",
    "match": "bean flicker|bean-flicker|beanflicker",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "bean-queen",
    "match": "bean queen",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "beaner",
    "match": "beaner|beaners",
    "tags": [
      "racial"
    ],
    "severity": 3,
    "exceptions": [
      "*ies",
      "*y"
    ]
  },
  {
    "id": "beastiality",
    "match": "beastiality|beestiality|bestiality",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "beaver-cleaver",
    "match": "beaver cleaver",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "beaver-lips",
    "match": "beaver lips",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "bellend",
    "match": "bell*end",
    "tags": [
      "general"
    ],
    "severity": 3,
    "exceptions": [
      "*en"
    ]
  },
  {
    "id": "bellesa",
    "match": "bellesa",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "bicon",
    "match": "bicon",
    "tags": [
      "lgbtq"
    ],
    "severity": 3,
    "exceptions": [
      "*cave",
      "*cavities",
      "*cavity",
      "*vex",
      "*vexities",
      "*vexity"
    ]
  },
  {
    "id": "big-boobs",
    "match": "big boobs|big breasts|big knockers|big tits",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "birdlock",
    "match": "birdlock",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "bitch",
    "match": "bi*tch|bi*tches",
    "tags": [
      "general"
    ],
    "severity": 3
  },
  {
    "id": "bloody",
    "match": "bloody",
    "tags": [
      "general"
    ],
    "severity": 1
  },
  {
    "id": "blow-your-load",
    "match": "blow your load",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "blowjob",
    "match": "blowjob|blow-job|blow job",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "blue-waffle",
    "match": "blue waffle|bluewaffle",
    "tags": [
      "shock"
    ],
    "severity": 4
  },
  {
    "id": "blumpkin",
    "match": "blumpkin",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "bollocks",
    "match": "bo*ll*o*cks",
    "tags": [
      "sexual"
    ],
    "severity": 1
  },
  {
    "id": "bone-smuggler",
    "match": "bone smuggler|bone-smuggler|bonesmuggler",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "boner",
    "match": "boner|raging boner|throbbing boner",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "boob",
    "match": "boo*b",
    "tags": [
      "sexual"
    ],
    "severity": 1,
    "exceptions": [
      "*ird",
      "*oo"
    ]
  },
  {
    "id": "booty-buffer",
    "match": "booty buffer|booty-buffer",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "booty-call",
    "match": "booty call",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "boston-george",
    "match": "boston george",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "breasts",
    "match": "breasts",
    "tags": [
      "sexual"
    ],
    "severity": 1,
    "exceptions": [
      "*troke"
    ]
  },
  {
    "id": "brown-piper",
    "match": "brown piper|brown-piper|brownpiper",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "brown-shower",
    "match": "brown shower|brown showers",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "brownie-royalty",
    "match": "brownie king|brownie queen",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "buddhahead",
    "match": "buddhahead|buddha head|buddha-head",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "bufter",
    "match": "bufter|bufty",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "bugger",
    "match": "bugg*er",
    "tags": [
      "general"
    ],
    "severity": 1,
    "exceptions": [
      "de*",
      "hum*"
    ]
  },
  {
    "id": "bukkake",
    "match": "bukkake",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "bulldyke",
    "match": "bulldyke",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "bullet-vibe",
    "match": "bullet vibe|bullet vibrator",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "bullshit",
    "match": "bullshit|bull-shit|bull shit",
    "tags": [
      "general"
    ],
    "severity": 2
  },
  {
    "id": "bum-chum",
    "match": "bum chum|bum-chum|bumchum",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "bum-driller",
    "match": "bum driller|bum-driller|bumdriller",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "butt-boy",
    "match": "butt boy|butt-boy|buttboy|bum boy|bum-boy|bumboy",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "butt-pilot",
    "match": "butt pilot|bum pilot",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "butt-pirate",
    "match": "butt pirate|butt-pirate|bum pirate|bum-pirate",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "butt-rider",
    "match": "butt rider|buttrider|bum rider|bumrider",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "butt-robber",
    "match": "butt robber|butt-robber|buttrobber|bum robber|bum-robber|bumrobber",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "butt-rustler",
    "match": "butt rustler|bum rustler",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "butthole-engineer",
    "match": "butthole engineer|bumhole engineer",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "camel-jockey",
    "match": "camel jockey|cameljockey|camel jockies|cameljockies",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "camel-toe",
    "match": "camel toe",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "canadian-porch-swing",
    "match": "canadian porch swing",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "carpet-muncher",
    "match": "carpet muncher|carpetmuncher",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "cheese-monkey",
    "match": "cheese-eating surrender monkey|cheese eating surrender monkey",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "chi-chi-man",
    "match": "chi chi man|chi-chi man",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "chicken-queen",
    "match": "chicken queen",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "chinaman",
    "match": "chinaman|china man|chinamen|china men",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "ching-chong",
    "match": "ching-chong|ching chong",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "chink",
    "match": "chink|chinks|chinky",
    "tags": [
      "racial"
    ],
    "severity": 3,
    "exceptions": [
      "*apin",
      "*apins",
      "*ed",
      "*ier",
      "*iest",
      "*ing",
      "pa*o",
      "pa*os"
    ]
  },
  {
    "id": "chocolate-rosebud",
    "match": "chocolate rosebud|chocolate rosebuds",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "cholerophilia",
    "match": "cholerophilia|cholerophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "christ",
    "match": "chri*st",
    "tags": [
      "religious"
    ],
    "severity": 1,
    "exceptions": [
      "*en",
      "*ian",
      "*ie",
      "*y"
    ]
  },
  {
    "id": "cialis",
    "match": "cialis",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "circlejerk",
    "match": "circlejerk|circle-jerk",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "cishet",
    "match": "cishet",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "cissy",
    "match": "cissy|cissie",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "claustrophilia",
    "match": "claustrophilia|claustrophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "cleveland-accordion",
    "match": "cleveland accordion",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "cleveland-hot-waffle",
    "match": "cleveland hot waffle",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "cleveland-steamer",
    "match": "cleveland steamer",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "clit",
    "match": "clit",
    "tags": [
      "sexual"
    ],
    "severity": 3,
    "exceptions": [
      "*ella",
      "*ellum",
      "*ic",
      "*icize",
      "*icized",
      "*icizes",
      "*icizing",
      "*ics",
      "ana*ic",
      "cy*ol",
      "cy*ols",
      "en*ic",
      "en*ics",
      "hetero*e",
      "hetero*es",
      "pa*axel",
      "pa*axels",
      "pro*ic",
      "pro*ics"
    ]
  },
  {
    "id": "clitoris",
    "match": "cli*tori*s",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "clover-clamps",
    "match": "clover clamps|clover clamp",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "clunge",
    "match": "clu*nge",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "clusterfuck",
    "match": "clusterfuck|cluster-fuck|cluster fuck",
    "tags": [
      "general"
    ],
    "severity": 4
  },
  {
    "id": "cock",
    "match": "cock",
    "tags": [
      "sexual"
    ],
    "severity": 2,
    "exceptions": [
      "*ade",
      "*aded",
      "*ades",
      "*alorum",
      "*alorums",
      "*amamie",
      "*amamy",
      "*apoo",
      "*apoos",
      "*ateel",
      "*ateels",
      "*atiel",
      "*atiels",
      "*atoo",
      "*atoos",
      "*atrice",
      "*atrices",
      "*bill",
      "*billed",
      "*billing",
      "*bills",
      "*boat",
      "*boats",
      "*chafer",
      "*chafers",
      "*crow",
      "*crows",
      "*ed",
      "*er",
      "*ered",
      "*erel",
      "*erels",
      "*ering",
      "*ers",
      "*eye",
      "*eyed",
      "*eyedly",
      "*eyedness",
      "*eyednesses",
      "*eyes",
      "*horse",
      "*horses",
      "*ier",
      "*iest",
      "*ily",
      "*iness",
      "*inesses",
      "*ing",
      "*ish",
      "*le",
      "*lebur",
      "*leburs",
      "*led",
      "*les",
      "*leshell",
      "*leshells",
      "*like",
      "*ling",
      "*loft",
      "*lofts",
      "*ney",
      "*neyfied",
      "*neyfies",
      "*neyfy",
      "*neyfying",
      "*neyish",
      "*neyism",
      "*neyisms",
      "*neys",
      "*pit",
      "*pits",
      "*roach",
      "*roaches",
      "*s",
      "*scomb",
      "*scombs",
      "*sfoot",
      "*sfoots",
      "*shies",
      "*shut",
      "*shuts",
      "*shy",
      "*spur",
      "*spurs",
      "*sucker",
      "*suckers",
      "*sure",
      "*surely",
      "*sureness",
      "*surenesses",
      "*swain",
      "*swains",
      "*tail",
      "*tailed",
      "*tailing",
      "*tails",
      "*up",
      "*ups",
      "*y",
      "a*",
      "baw*",
      "baw*s",
      "bib*",
      "bib*s",
      "billy*",
      "billy*s",
      "black*",
      "black*s",
      "cold*",
      "cold*ed",
      "cold*ing",
      "cold*s",
      "game*",
      "game*s",
      "gor*",
      "gor*s",
      "hay*",
      "hay*s",
      "moor*",
      "moor*s",
      "pea*",
      "pea*ed",
      "pea*ier",
      "pea*iest",
      "pea*ing",
      "pea*ish",
      "pea*s",
      "pea*y",
      "pet*",
      "pet*s",
      "pinch*",
      "pinch*s",
      "poppy*",
      "poppy*s",
      "prin*",
      "prin*s",
      "re*",
      "re*ed",
      "re*ing",
      "re*s",
      "sea*",
      "sea*s",
      "shuttle*",
      "shuttle*ed",
      "shuttle*ing",
      "shuttle*s",
      "stop*",
      "stop*s",
      "un*",
      "un*ed",
      "un*ing",
      "un*s",
      "weather*",
      "weather*s",
      "wood*",
      "wood*s"
    ]
  },
  {
    "id": "cockpipe-cosmonaut",
    "match": "cockpipe cosmonaut",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "cockstruction-worker",
    "match": "cockstruction worker",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "coimetrophilia",
    "match": "coimetrophilia|coimetrophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "collaring",
    "match": "collaring|collared",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "coon",
    "match": "coon|coons",
    "tags": [
      "racial"
    ],
    "severity": 3,
    "exceptions": [
      "barra*",
      "coc*",
      "coc*ed",
      "puc*",
      "rac*",
      "ty*",
      "*tie",
      "* can",
      "*can",
      "* hound",
      "*hound",
      "* skin",
      "*skin"
    ]
  },
  {
    "id": "coprophilia",
    "match": "coprophilia|coprophile|coprolagnia",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "cornhole",
    "match": "cornhole",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "crafty-butcher",
    "match": "crafty butcher",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "crap",
    "match": "cra*p",
    "tags": [
      "general"
    ],
    "severity": 1,
    "exceptions": [
      "*e",
      "*ing",
      "*shoot",
      "*ulent",
      "*ulous",
      "s*"
    ]
  },
  {
    "id": "creampie",
    "match": "creampie|cream-pie",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "cum",
    "match": "cum",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "cumming",
    "match": "cumming",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "cumshot",
    "match": "cumshot|cumshots|cum shot|cum shots",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "cunnilingus",
    "match": "cunnilingus",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "cunt",
    "match": "cu*n*t|ku*nt|cunts|kunts",
    "tags": [
      "general"
    ],
    "severity": 4,
    "exceptions": [
      "s*horpe"
    ]
  },
  {
    "id": "cuntboy",
    "match": "cuntboy|cunt-boy|cunt boy",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "curry-muncher",
    "match": "curry muncher|curry-muncher|currymuncher",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "damn",
    "match": "da*mn",
    "tags": [
      "religious"
    ],
    "severity": 1
  },
  {
    "id": "darkie",
    "match": "darkie|darkies|darky|darkey",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "date-rape",
    "match": "date rape|daterape",
    "tags": [
      "sexual"
    ],
    "severity": 4
  },
  {
    "id": "ddlg",
    "match": "ddlg",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "deep-throat",
    "match": "deep throat|deep-throat|deepthroat",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "dendrophilia",
    "match": "dendrophilia|dendrophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "dick",
    "match": "di*ck",
    "tags": [
      "sexual"
    ],
    "severity": 2,
    "exceptions": [
      "*cissel",
      "*en",
      "*er",
      "bene*",
      "me*",
      "zad*"
    ]
  },
  {
    "id": "dickgirl",
    "match": "dickgirl|dick-girl|dick girl",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "dildo",
    "match": "dildo|dildos",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "dingleberry",
    "match": "dingleberry|dingleberries",
    "tags": [
      "general"
    ],
    "severity": 1
  },
  {
    "id": "dipsea",
    "match": "dipsea",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "dirty-pillows",
    "match": "dirty pillows",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "dirty-sanchez",
    "match": "dirty sanchez",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "dishabiliophilia",
    "match": "dishabiliophilia|dishabiliophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "doggie-style",
    "match": "doggie style|doggie-style|doggiestyle|doggy style|doggy-style|doggystyle|dog style",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "dogshit",
    "match": "dogshit|dog-shit|dog shit",
    "tags": [
      "general"
    ],
    "severity": 2
  },
  {
    "id": "dolcett",
    "match": "dolcett",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "domination",
    "match": "domination",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "dominatrix",
    "match": "dominatrix|domme|dommes",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "donkey-punch",
    "match": "donkey punch",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "donut-muncher",
    "match": "donut muncher",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "donut-puncher",
    "match": "donut puncher",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "double-penetration",
    "match": "double penetration|dp action",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "dry-hump",
    "match": "dry hump",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "dune-coon",
    "match": "dune coon|dune-coon|doon coon|dooncoon",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "dutch-rudder",
    "match": "dutch rudder",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "dyke",
    "match": "dyke",
    "tags": [
      "lgbtq"
    ],
    "severity": 3,
    "exceptions": [
      "van*",
      "van*d",
      "van*s"
    ]
  },
  {
    "id": "dystychiphilia",
    "match": "dystychiphilia|dystychiphile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "edgeplay",
    "match": "edgeplay|edge play",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "ejaculate",
    "match": "ejaculate|ejaculation|ejaculating|ejaculated",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "electro-play",
    "match": "electro-play|electroplay",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "emetophilia",
    "match": "emetophilia|emetophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "enby",
    "match": "enby",
    "tags": [
      "lgbtq"
    ],
    "severity": 3,
    "exceptions": [
      "all*",
      "as*",
      "brook*",
      "ca*",
      "d*",
      "froz*te",
      "gat*",
      "hold*",
      "lack*",
      "laz*",
      "nav*",
      "ott*",
      "r*gda",
      "t*",
      "warr*",
      "wh*"
    ]
  },
  {
    "id": "eskimo-trebuchet",
    "match": "eskimo trebuchet",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "eyetie",
    "match": "eyetie|eye-tie",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "fag",
    "match": "fa*g",
    "tags": [
      "lgbtq"
    ],
    "severity": 3,
    "exceptions": [
      "lea*e",
      "lea*es",
      "ser*e",
      "ser*es",
      "whar*e",
      "whar*es"
    ]
  },
  {
    "id": "fag-bomb",
    "match": "fag bomb|fag-bomb|fagbomb",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "faggot",
    "match": "fa*gg*o*t|fagot",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "felch",
    "match": "felch|felching",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "fellatio",
    "match": "fellatio|fellating",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "female-squirting",
    "match": "female squirting",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "figging",
    "match": "figging",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "fingerbang",
    "match": "fingerbang|finger bang|fingerbanging",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "fingering",
    "match": "fingering|fingered",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "finocchio",
    "match": "finocchio|finochio|finoccio",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "fisting",
    "match": "fisting|fisted",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "footjob",
    "match": "footjob|foot-job|foot job",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "french-rudder",
    "match": "french rudder",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "frogeater",
    "match": "frogeater|frog-eater|frog eater",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "frolicme",
    "match": "frolicme|frolic me",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "frotting",
    "match": "frotting|frottage",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "fuck",
    "match": "fu*c*k|fucks|fu*c*ken|fu*c*ker|fu*ckers|fu*c*kin|fu*c*king",
    "tags": [
      "general"
    ],
    "severity": 4
  },
  {
    "id": "fuckhead",
    "match": "fuckhead|fuckheads",
    "tags": [
      "general"
    ],
    "severity": 4
  },
  {
    "id": "fucktard",
    "match": "fucktard|fucktards",
    "tags": [
      "general"
    ],
    "severity": 4
  },
  {
    "id": "fuckwad",
    "match": "fuckwad|fuckwads",
    "tags": [
      "general"
    ],
    "severity": 4
  },
  {
    "id": "fuckwit",
    "match": "fuckwit|fuckwits|fuckwhit|fuck-wit",
    "tags": [
      "general"
    ],
    "severity": 4
  },
  {
    "id": "fudge-packer",
    "match": "fudge packer|fudge-packer|fudgepacker",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "futanari",
    "match": "futanari",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "g-spot",
    "match": "g-spot",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "gangbang",
    "match": "gangbang|gang bang",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "gay-sex",
    "match": "gay sex",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "gaysian",
    "match": "gaysian",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "genitals",
    "match": "genitals",
    "tags": [
      "sexual"
    ],
    "severity": 1
  },
  {
    "id": "genitorture",
    "match": "genitorture",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "gerontophilia",
    "match": "gerontophilia|gerontophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "gin-jockey",
    "match": "gin jockey|gin jocky",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "girl-on-top",
    "match": "girl on top",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "goatse",
    "match": "goatse|goatcx",
    "tags": [
      "shock"
    ],
    "severity": 4
  },
  {
    "id": "god-damn",
    "match": "god damn|god-damn|goddamn|god damned|god-damned|goddamned",
    "tags": [
      "religious"
    ],
    "severity": 2
  },
  {
    "id": "gokkun",
    "match": "gokkun|go-kun",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "golden-shower",
    "match": "golden shower|golden showers|yellow shower|yellow showers",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "golliwog",
    "match": "golliwog|gollywog",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "gook",
    "match": "gook|gooks|gook-eye|gooky|gookie",
    "tags": [
      "racial"
    ],
    "severity": 3,
    "exceptions": [
      "gobblede*",
      "gobblede*s",
      "gobbledy*",
      "gobbledy*s"
    ]
  },
  {
    "id": "goregasm",
    "match": "goregasm",
    "tags": [
      "sexual"
    ],
    "severity": 4
  },
  {
    "id": "greaseball",
    "match": "greaseball",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "grey-queen",
    "match": "grey queen|gray queen",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "grope",
    "match": "grope",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "group-sex",
    "match": "group sex",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "gym-bunny",
    "match": "gym bunny|gymbunny",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "hajji",
    "match": "haji|hajj*i|hadji",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "hand-job",
    "match": "hand job|hand-job|handjob",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "hermie",
    "match": "hermie",
    "tags": [
      "lgbtq"
    ],
    "severity": 3,
    "exceptions": [
      "diat*s",
      "endot*s",
      "homeot*s"
    ]
  },
  {
    "id": "hickory-switch",
    "match": "hickory switch",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "hippophilia",
    "match": "hippophilia|hippophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "homoerotic",
    "match": "homoerotic",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "honkey",
    "match": "honkey|honky|honkeys|honkies",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "horny",
    "match": "horny",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "horseshit",
    "match": "horseshit|horse-shit|horse shit",
    "tags": [
      "general"
    ],
    "severity": 2
  },
  {
    "id": "hot-carl",
    "match": "hot carl",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "hot-richard",
    "match": "hot richard",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "humping",
    "match": "humping",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "hymie",
    "match": "hymie|heimie",
    "tags": [
      "racial"
    ],
    "severity": 2,
    "exceptions": [
      "alc*s",
      "prings*ella",
      "t*r",
      "t*st"
    ]
  },
  {
    "id": "impact-play",
    "match": "impact play|impact-play",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "incest",
    "match": "incest",
    "tags": [
      "sexual"
    ],
    "severity": 4
  },
  {
    "id": "intercourse",
    "match": "intercourse",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "jack-off",
    "match": "jack off|jack-off",
    "tags": [
      "sexual"
    ],
    "severity": 2
  },
  {
    "id": "jail-bait",
    "match": "jail bait|jailbait",
    "tags": [
      "sexual"
    ],
    "severity": 4
  },
  {
    "id": "jap",
    "match": "jap",
    "tags": [
      "racial"
    ],
    "severity": 1,
    "exceptions": [
      "*an",
      "*anize",
      "*anized",
      "*anizes",
      "*anizing",
      "*anned",
      "*anners",
      "*anner",
      "*anning",
      "*ans",
      "*e",
      "*ed",
      "*er",
      "*eries",
      "*ers",
      "*ery",
      "*es",
      "*ing",
      "*ingly",
      "*onica",
      "*onicas",
      "*onaiserie",
      "*onaiseries",
      "ca*ut",
      "ca*uts",
      "jipi*a",
      "jipi*as"
    ]
  },
  {
    "id": "jelly-donut",
    "match": "jelly donut",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "jerk-off",
    "match": "jerk off|jerk-off",
    "tags": [
      "sexual"
    ],
    "severity": 2
  },
  {
    "id": "jerkmate",
    "match": "jerkmate|jerk mate",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "jesus",
    "match": "je*su*s",
    "tags": [
      "religious"
    ],
    "severity": 1,
    "exceptions": [
      "be*"
    ]
  },
  {
    "id": "jesus-christ",
    "match": "je*su*s chri*st",
    "tags": [
      "religious"
    ],
    "severity": 2
  },
  {
    "id": "jigaboo",
    "match": "jig*aboo*|jig*gerboo*",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "jizz",
    "match": "jizz",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "juggs",
    "match": "juggs",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "jungle-bunny",
    "match": "jungle bunny|junglebunny",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "kennebunkport-surprise",
    "match": "kennebunkport surprise",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "kentucky-klondike",
    "match": "kentucky klondike",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "kentucky-tractor-puller",
    "match": "kentucky tractor puller",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "kike",
    "match": "ki*ke",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "kinbaku",
    "match": "kinbaku",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "kitty-puncher",
    "match": "kitty puncher|kitty-puncher|kittypuncher",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "knobbing",
    "match": "knobbing",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "kraut",
    "match": "kraut|krauts",
    "tags": [
      "racial"
    ],
    "severity": 1,
    "exceptions": [
      "sauer*s",
      "sauer*"
    ]
  },
  {
    "id": "kynophilia",
    "match": "kynophilia|kynophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "lady-boy",
    "match": "lady boy|lady-boy|ladyboy",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "leather-restraint",
    "match": "leather restraint",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "leather-straight-jacket",
    "match": "leather straight jacket",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "lemon-party",
    "match": "lemon party|lemonparty",
    "tags": [
      "shock"
    ],
    "severity": 4
  },
  {
    "id": "leningrad-steamer",
    "match": "leningrad steamer",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "lesbo",
    "match": "lesbo",
    "tags": [
      "lgbtq"
    ],
    "severity": 3,
    "exceptions": [
      "*s",
      "b*k",
      "b*ks"
    ]
  },
  {
    "id": "leso",
    "match": "leso",
    "tags": [
      "lgbtq"
    ],
    "severity": 3,
    "exceptions": [
      "bung*me",
      "chuck*me",
      "crad*ng",
      "crad*ngs",
      "cudd*me",
      "do*me",
      "medd*me",
      "medd*meness",
      "mett*me",
      "nett*me",
      "troub*me",
      "troub*mely",
      "troub*meness",
      "unwho*me",
      "unwho*mely",
      "who*me",
      "who*mer",
      "who*mest",
      "who*mely",
      "who*meness",
      "who*menesses"
    ]
  },
  {
    "id": "lezzie",
    "match": "lezzie|lezzies",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "light-fedora",
    "match": "light in the fedora",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "light-loafers",
    "match": "light in the loafers",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "light-pants",
    "match": "light in the pants",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "limp-wristed",
    "match": "limp wristed|limp-wristed",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "literotica",
    "match": "literotica",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "lovemaking",
    "match": "lovemaking",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "male-squirting",
    "match": "male squirting|male-squirting",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "masturbate",
    "match": "ma*stu*rbate|ma*stu*rb8|masturbation|masturbating|masterbate|masterb8",
    "tags": [
      "sexual"
    ],
    "severity": 2
  },
  {
    "id": "mayonnaise-monkey",
    "match": "mayonnaise monkey|mayonnaise monkies",
    "tags": [
      "racial"
    ],
    "severity": 1
  },
  {
    "id": "mdlb",
    "match": "mdlb",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "meat-masseuse",
    "match": "meat masseuse",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "meatspin",
    "match": "meatspin|meat spin",
    "tags": [
      "shock"
    ],
    "severity": 4
  },
  {
    "id": "menage-a-trois",
    "match": "menage a trois|menage-a-trois|menages a trois|menages-a-trois",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "menophilia",
    "match": "menophilia|menophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "mexican-pancake",
    "match": "mexican pancake",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "milwaukee-blizzard",
    "match": "milwaukee blizzard",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "missionary-position",
    "match": "missionary position",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "mississippi-birdbath",
    "match": "mississippi birdbath",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "mr-hands",
    "match": "mr. hands|mr hands|mrhands",
    "tags": [
      "shock"
    ],
    "severity": 4
  },
  {
    "id": "muff-diver",
    "match": "muff diver|muff-diver|muffdiver",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "muffdiving",
    "match": "muffdiving|muff diving|muffdiver|muff diver",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "muscle-mary",
    "match": "muscle mary",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "mvtube",
    "match": "mvtube",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "nambla",
    "match": "nambla",
    "tags": [
      "sexual"
    ],
    "severity": 4
  },
  {
    "id": "necrophilia",
    "match": "necrophilia|necrophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "negro",
    "match": "negro",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "neonazi",
    "match": "neonazi|neo-nazi|neo nazi",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "nigerian-hurricane",
    "match": "nigerian hurricane",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "nigga",
    "match": "ni*gg*a|ni*gg*s|nignog|nig nog",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "nigger",
    "match": "ni*gg*e*r",
    "tags": [
      "racial"
    ],
    "severity": 4
  },
  {
    "id": "nipple-clamps",
    "match": "nipple clamps|nipple clamp",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "nipples",
    "match": "nipples|nipple",
    "tags": [
      "sexual"
    ],
    "severity": 1
  },
  {
    "id": "nude",
    "match": "nude|nudity",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "nutten",
    "match": "nutten",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "nymphomania",
    "match": "nymphomania|nymphomaniac|nympho|nimphomania|nimphomaniac|nimpho",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "octopussy",
    "match": "octopussy",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "oklahomo",
    "match": "oklahomo",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "omorashi",
    "match": "omorashi",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "onlyfans",
    "match": "onlyfans|only fans",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "orgasm",
    "match": "orgasm|orgasms|orgasmic",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "paedophilia|pedophilia",
    "match": "paedophilia|pedophilia|paedophile|pedophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "painslut",
    "match": "painslut|pain slut",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "paki",
    "match": "paki",
    "tags": [
      "racial"
    ],
    "severity": 3,
    "exceptions": [
      "*hi"
    ]
  },
  {
    "id": "panamanian-petting-zoo",
    "match": "panamanian petting zoo",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "pansy",
    "match": "pansy",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "panties",
    "match": "panties",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "parthenophilia",
    "match": "parthenophilia|parthenophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "pedobear",
    "match": "pedobear|paedobear|pedo bear|paedo bear",
    "tags": [
      "sexual"
    ],
    "severity": 4
  },
  {
    "id": "pegging",
    "match": "pegging",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "penis",
    "match": "pe*ni*s",
    "tags": [
      "sexual"
    ],
    "severity": 1,
    "exceptions": [
      "top*h"
    ]
  },
  {
    "id": "peterpuffer",
    "match": "peterpuffer|peter-puffer|peter puffer",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "petrol-sniffer",
    "match": "petrol sniffer|petrol-sniffer|petrolsniffer",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "phagophilia",
    "match": "phagophilia|phagophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "piece-of-shit",
    "match": "piece of shit|pieces of shit",
    "tags": [
      "general"
    ],
    "severity": 2
  },
  {
    "id": "pikey",
    "match": "pikey|pikeys",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "piss-off",
    "match": "pi*ss* off",
    "tags": [
      "general"
    ],
    "severity": 2
  },
  {
    "id": "piss-pig",
    "match": "piss pig|pisspig",
    "tags": [
      "sexual"
    ],
    "severity": 4
  },
  {
    "id": "piss-pig",
    "match": "piss pig|pisspig",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "pissed-off",
    "match": "pi*ss*ed off",
    "tags": [
      "general"
    ],
    "severity": 2
  },
  {
    "id": "pissing",
    "match": "pissing",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "playboy",
    "match": "playboy",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "pleasure-chest",
    "match": "pleasure chest",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "pnigerophilia|pnigophilia",
    "match": "pnigerophilia|pnigophilia|pnigerophile|pnigophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "poinephilia",
    "match": "poinephilia|poinephile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "ponyboy",
    "match": "ponyboy|pony-boy|pony boy",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "ponygirl",
    "match": "ponygirl|pony-girl|pony girl",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "ponyplay",
    "match": "ponyplay|pony-play",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "poof",
    "match": "poof",
    "tags": [
      "lgbtq"
    ],
    "severity": 3,
    "exceptions": [
      "*s",
      "*tah",
      "*tahs",
      "*ter",
      "*ters",
      "*y",
      "s*",
      "s*ed",
      "s*er",
      "s*eries",
      "s*ers",
      "s*ery",
      "s*ing",
      "s*s",
      "s*y"
    ]
  },
  {
    "id": "poon",
    "match": "poon|poontang",
    "tags": [
      "sexual"
    ],
    "severity": 3,
    "exceptions": [
      "cram*",
      "cram*s",
      "desserts*",
      "desserts*ful",
      "desserts*s",
      "har*",
      "har*ed",
      "har*er",
      "har*ers",
      "har*ing",
      "har*s",
      "lam*",
      "lam*ed",
      "lam*er",
      "lam*eries",
      "lam*ers",
      "lam*ery",
      "lam*ing",
      "lam*s",
      "s*",
      "s*bill",
      "s*bills",
      "s*ed",
      "s*erism",
      "s*erisms",
      "s*ey",
      "s*eys",
      "s*ful",
      "s*fuls",
      "s*ier",
      "s*ies",
      "s*iest",
      "s*ily",
      "s*ing",
      "s*s",
      "s*sful",
      "s*y",
      "soups*",
      "soups*s",
      "tables*",
      "tables*ful",
      "tables*fuls",
      "tables*s",
      "tables*sful",
      "teas*",
      "teas*ful",
      "teas*fuls",
      "teas*s",
      "teas*sful"
    ]
  },
  {
    "id": "poop-chute",
    "match": "poop chute|poopchute",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "pornhub",
    "match": "pornhub|porn hub",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "pornography",
    "match": "pornography|pornographic|porno|pornos|porn",
    "tags": [
      "sexual"
    ],
    "severity": 2
  },
  {
    "id": "potato-queen",
    "match": "potato queen",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "prince-albert-piercing",
    "match": "prince albert piercing",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "proctophilia",
    "match": "proctophilia|proctophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "pubes",
    "match": "pubes",
    "tags": [
      "sexual"
    ],
    "severity": 1
  },
  {
    "id": "punani",
    "match": "pu*na*ni|punany",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "pussy",
    "match": "pu*ss*y",
    "tags": [
      "general"
    ],
    "severity": 3
  },
  {
    "id": "pussy-puncher",
    "match": "pussy puncher|pussy-puncher|pussypuncher",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "queef",
    "match": "queef|queaf",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "quim",
    "match": "quim",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "raghead",
    "match": "raghead|rag head|ragheads|rag heads",
    "tags": [
      "religious"
    ],
    "severity": 3
  },
  {
    "id": "ramen-yarmulke",
    "match": "ramen yarmulke",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "rape",
    "match": "rape",
    "tags": [
      "sexual"
    ],
    "severity": 4
  },
  {
    "id": "raping",
    "match": "raping|rapist",
    "tags": [
      "sexual"
    ],
    "severity": 4
  },
  {
    "id": "rectum",
    "match": "rectum",
    "tags": [
      "sexual"
    ],
    "severity": 1
  },
  {
    "id": "retard",
    "match": "retard|retarded",
    "tags": [
      "general"
    ],
    "severity": 2
  },
  {
    "id": "reverse-cowgirl",
    "match": "reverse cowgirl",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "rhabdophilia",
    "match": "rhabdophilia|rhabdophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "rhypophilia",
    "match": "rhypophilia|rhypophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "rice-queen",
    "match": "rice queen",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "rimjob",
    "match": "rimjob|rimming",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "ring-raider",
    "match": "ring raider|ringraider",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "rusty-trombone",
    "match": "rusty trombone",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "sand-nigger",
    "match": "sand ni*gg*e*r|sand-ni*gg*e*r|sandni*gg*e*r",
    "tags": [
      "racial"
    ],
    "severity": 4
  },
  {
    "id": "santorum",
    "match": "santorum",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "scatophilia",
    "match": "scatophilia|scatophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "schlong",
    "match": "schlong|shlong",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "scissoring",
    "match": "scissoring",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "semen",
    "match": "semen",
    "tags": [
      "sexual"
    ],
    "severity": 1,
    "exceptions": [
      "aba*t",
      "aba*ts",
      "adverti*t",
      "adverti*ts",
      "advi*t",
      "advi*ts",
      "amu*t",
      "amu*ts",
      "appea*t",
      "appea*ts",
      "apprai*t",
      "apprai*ts",
      "arrondis*t",
      "arrondis*ts",
      "ba*",
      "ba*t",
      "ba*tless",
      "ba*ts",
      "bemu*t",
      "bemu*ts",
      "boulever*t",
      "boulever*ts",
      "ca*t",
      "ca*ts",
      "chasti*t",
      "chasti*ts",
      "deba*t",
      "deba*ts",
      "defen*",
      "despi*t",
      "despi*ts",
      "disbur*t",
      "disbur*ts",
      "disgui*t",
      "disgui*ts",
      "divertis*t",
      "divertis*ts",
      "ea*t",
      "ea*ts",
      "eclaircis*t",
      "empres*t",
      "empres*ts",
      "enca*t",
      "enca*ts",
      "endor*t",
      "endor*ts",
      "enfranchi*t",
      "exci*",
      "hor*",
      "hou*",
      "indor*t",
      "indor*ts",
      "pas*terie",
      "pas*teries",
      "reimbur*t",
      "reimbur*ts",
      "rou*t",
      "rou*ts",
      "subba*t",
      "subba*ts",
      "ver*",
      "warehou*"
    ]
  },
  {
    "id": "seplophilia",
    "match": "seplophilia|seplophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "sex",
    "match": "sex",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "shaved pussy",
    "match": "shaved pussy|shaved beaver",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "sheepshagger",
    "match": "sheepshagger|sheep shagger",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "shemale",
    "match": "shemale|she-male|she male",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "shibari",
    "match": "shibari",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "shit",
    "match": "sh*i*t",
    "tags": [
      "general"
    ],
    "severity": 2,
    "exceptions": [
      "*ake",
      "mi*",
      "*tah",
      "*tim"
    ]
  },
  {
    "id": "shithead",
    "match": "shithead|shit head",
    "tags": [
      "general"
    ],
    "severity": 3
  },
  {
    "id": "shitty",
    "match": "shi*tt*y",
    "tags": [
      "general"
    ],
    "severity": 2
  },
  {
    "id": "shota",
    "match": "shota",
    "tags": [
      "sexual"
    ],
    "severity": 4
  },
  {
    "id": "shrimping",
    "match": "shrimping",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "sissy",
    "match": "sissy",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "skeet",
    "match": "skeet",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "skittles-harvest",
    "match": "skittles harvest|skittle harvest",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "slanteye",
    "match": "slanteye|slant-eye|slant eye",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "snatch",
    "match": "snatch",
    "tags": [
      "sexual"
    ],
    "severity": 1
  },
  {
    "id": "snowballing",
    "match": "snowballing",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "sod-off",
    "match": "sod off",
    "tags": [
      "general"
    ],
    "severity": 1
  },
  {
    "id": "sodding",
    "match": "sodding",
    "tags": [
      "general"
    ],
    "severity": 1
  },
  {
    "id": "sodomize",
    "match": "sodomize|sodomise|sodomist|sodomy",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "spastic",
    "match": "spastic",
    "tags": [
      "general"
    ],
    "severity": 2
  },
  {
    "id": "spearchucker",
    "match": "spearchucker",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "spic",
    "match": "spic|spics|spick|spicks",
    "tags": [
      "racial"
    ],
    "severity": 3,
    "exceptions": [
      "*a",
      "*ae",
      "*as",
      "*ate",
      "*ated",
      "*cato",
      "*catos",
      "*e",
      "*ebush",
      "*ebushes",
      "*ed",
      "*eless",
      "*er",
      "*eries",
      "*ers",
      "*ery",
      "*es",
      "*ey",
      "*ier",
      "*iest",
      "*ily",
      "*iness",
      "*inesses",
      "*ing",
      "*ks",
      "*ula",
      "*ulae",
      "*ular",
      "*ulate",
      "*ulation",
      "*ulations",
      "*ule",
      "*ules",
      "*ulum",
      "*y",
      "a*",
      "a*s",
      "all*e",
      "all*es",
      "aru*es",
      "au*ate",
      "au*ated",
      "au*ates",
      "au*ating",
      "au*e",
      "au*es",
      "au*ious",
      "au*iously",
      "au*iousness",
      "con*uities",
      "con*uity",
      "con*uous",
      "con*uously",
      "con*uousness",
      "de*able",
      "de*ableness",
      "de*ably",
      "haru*ation",
      "haru*ations",
      "haru*es",
      "ho*e",
      "ho*es",
      "inau*ious",
      "inau*iously",
      "incon*uous",
      "incon*uously",
      "mi*kel",
      "mi*kels",
      "over*e",
      "over*ed",
      "over*es",
      "over*ing",
      "oversu*ious",
      "per*acious",
      "per*aciously",
      "per*acities",
      "per*acity",
      "per*uities",
      "per*uity",
      "per*uous",
      "per*uously",
      "per*uousness",
      "su*ion",
      "su*ioned",
      "su*ioning",
      "su*ions",
      "su*ious",
      "su*iously",
      "su*iousness",
      "tran*uous",
      "unsu*ious"
    ]
  },
  {
    "id": "spicy-gringo",
    "match": "spicy gringo",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "splooge",
    "match": "splooge|splooge moose|spooge",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "spunk",
    "match": "spunk",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "strap-on",
    "match": "strap on|strap-on",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "strap-on",
    "match": "strap-on|strapon",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "strappado",
    "match": "strappado",
    "tags": [
      "sexual"
    ],
    "severity": 4
  },
  {
    "id": "swamp-guinea",
    "match": "swamp guinea|swamp-guinea",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "swastika",
    "match": "swastika|svastika|suastika",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "switch-hitter",
    "match": "switch hitter",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "t-girl",
    "match": "t-girl|tgirl",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "taphephilia",
    "match": "taphephilia|taphephile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "tea-bagging",
    "match": "tea bagging|tea-bagging|tea bagged|tea-bagged",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "thanatophilia",
    "match": "thanatophilia|thanatophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "threesome",
    "match": "threesome",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "throating",
    "match": "throating",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "thumbzilla",
    "match": "thumbzilla",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "timber-nigger",
    "match": "timber ni*gg*e*r|timber-ni*gg*e*r|timberni*gg*e*r",
    "tags": [
      "racial"
    ],
    "severity": 4
  },
  {
    "id": "tits",
    "match": "tits",
    "tags": [
      "sexual"
    ],
    "severity": 2,
    "exceptions": [
      "bush*",
      "pas*",
      "tom*"
    ]
  },
  {
    "id": "titty",
    "match": "titt*y|titt*ies",
    "tags": [
      "sexual"
    ],
    "severity": 2
  },
  {
    "id": "topless",
    "match": "topless",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "tosser",
    "match": "tosser",
    "tags": [
      "general"
    ],
    "severity": 2
  },
  {
    "id": "towelhead",
    "match": "towelhead|towel-head|towel head",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "tranny",
    "match": "tranny|trannie",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "transbian",
    "match": "transbian",
    "tags": [
      "lgbtq"
    ],
    "severity": 3
  },
  {
    "id": "traumatophilia",
    "match": "traumatophilia|traumatophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "tribbing",
    "match": "tribbing|tribadism",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "tubgirl",
    "match": "tubgirl|tub girl",
    "tags": [
      "shock"
    ],
    "severity": 4
  },
  {
    "id": "twat",
    "match": "twa*t",
    "tags": [
      "general"
    ],
    "severity": 3,
    "exceptions": [
      "cu*er",
      "mel*er",
      "ou*ch",
      "sal*er",
      "wris*ch"
    ]
  },
  {
    "id": "twink",
    "match": "twink",
    "tags": [
      "lgbtq"
    ],
    "severity": 3,
    "exceptions": [
      "*ie",
      "*ies",
      "*le",
      "*led",
      "*ler",
      "*les",
      "*lers",
      "*ling",
      "*lings",
      "*ly"
    ]
  },
  {
    "id": "urethra-play",
    "match": "urethra play",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "urophilia",
    "match": "urophilia|urophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "vagina",
    "match": "vagina",
    "tags": [
      "sexual"
    ],
    "severity": 1
  },
  {
    "id": "venus-mound",
    "match": "venus mound|mound of venus",
    "tags": [
      "sexual"
    ],
    "severity": 1
  },
  {
    "id": "viagra",
    "match": "viagra",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "vibrator",
    "match": "vibrator",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "violet-wand",
    "match": "violet wand",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "vorarephilia",
    "match": "vorarephilia|vorarephile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "voyeurweb",
    "match": "voyeurweb",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "wagon-burner",
    "match": "wagon burner|wagon-burner",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "wank",
    "match": "wa*nk",
    "tags": [
      "sexual"
    ],
    "severity": 2,
    "exceptions": [
      "s*",
      "t*"
    ]
  },
  {
    "id": "wanker",
    "match": "wa*nker",
    "tags": [
      "general"
    ],
    "severity": 2
  },
  {
    "id": "wax-play",
    "match": "wax play|wax-play",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "wet-dream",
    "match": "wet dream",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "wetback",
    "match": "wetback|wet-back|wet back",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "white power",
    "match": "whitepower|white-power|white power",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "whore",
    "match": "who*re",
    "tags": [
      "general"
    ],
    "severity": 3
  },
  {
    "id": "wigger",
    "match": "wigger|whigger|wigga",
    "tags": [
      "racial"
    ],
    "severity": 2
  },
  {
    "id": "wiitwd",
    "match": "wiitwd",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "wog",
    "match": "wog|wogs",
    "tags": [
      "racial"
    ],
    "severity": 1,
    "exceptions": [
      "horns*gle",
      "horns*gled",
      "horns*gles",
      "horns*gling",
      "polli*",
      "polli*s",
      "polly*",
      "polly*s"
    ]
  },
  {
    "id": "wolfbagging",
    "match": "wolfbagging",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "worldsex",
    "match": "worldsex",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "wrapping-men",
    "match": "wrapping men",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "wrinkled-starfish",
    "match": "wrinkled starfish",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "xhamster",
    "match": "xhamster",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "xnxx",
    "match": "xnxx",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "xtube",
    "match": "xtube",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "xvideos",
    "match": "xvideos",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "xxx",
    "match": "xxx",
    "tags": [
      "sexual"
    ],
    "severity": 2
  },
  {
    "id": "xyrophilia",
    "match": "xyrophilia|xyrophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  },
  {
    "id": "zipperhead",
    "match": "zipperhead|zipper-head|zipper head",
    "tags": [
      "racial"
    ],
    "severity": 3
  },
  {
    "id": "zippocat",
    "match": "zippocat|zippo-cat|zippo cat",
    "tags": [
      "shock"
    ],
    "severity": 4
  },
  {
    "id": "zoophilia",
    "match": "zoophilia|zoophile",
    "tags": [
      "sexual"
    ],
    "severity": 3
  }
]

if (!fs.existsSync(path.join(configPath, "swears.json"))) {
  fs.writeFileSync(
    path.join(configPath, "swears.json"),
    JSON.stringify(swears, null, 2)
  );
  console.log(`Created sweear filter file at ${path.join(configPath, "swears.json")}`);
} else {
  console.log(`Swear filter loaded from ${path.join(configPath, "swears.json")}`);
}