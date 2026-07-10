# Per-brand configuration for the report generator.
# Column indices are 0-based positions in each sheet's row arrays.

$Brands = @(
    @{
        Brand       = "mcaffeine"
        Title       = "mCaffeine"
        SpreadsheetId = "1fjrwKgi26q3kxsLsFrXP0KY0uAJNfcpTeHBQhCXwkPA"
        SheetName   = "mCaffeine"
        LastCol     = "AG"
        TotalRows   = 91675
        OutFile     = "mcaffeine.html"
        Months      = @("12_Dec'25","1_Jan'26","2_Feb'26","3_Mar'26","4_Apr'26","5_May'26","6_Jun'26","7_Jul'26")
        Classes     = @(
            @{ key="Delivery"; id="delivery"; label="Delivery"; color="var(--s1)" },
            @{ key="Warehouse"; id="warehouse"; label="Warehouse"; color="var(--s2)" },
            @{ key="Technical"; id="technical"; label="Technical"; color="var(--s3)" },
            @{ key="Packaging and Operational"; id="packaging"; label="Packaging & Operational"; color="var(--s4)" },
            @{ key="Product"; id="product"; label="Product"; color="var(--s5)" },
            @{ key="Product Suggestion/Recommendation"; id="suggestion"; label="Product Suggestion"; color="var(--s6)" }
        )
        Col = @{ prod=6; batch=7; sku=8; cls=4; cat=5; partner=10; month=12; sales=19; alloc=23; uniq=17;
                 wh=21; lastsource=3; platform=32; visdamage=30; outerpkg=29; statezone=28 }
        SmallTabs = @{ mom="MoM"; prodnps="MCF:PRODUCT NPS"; agent="AGENT"; ai="AI" }
    },
    @{
        Brand       = "hyphen"
        Title       = "Hyphen"
        SpreadsheetId = "11RM238fAcqZxLKF1zzrUB0fPTQgDO2kwfkzcQSoYjBg"
        SheetName   = "Hyphen"
        LastCol     = "AO"
        TotalRows   = 100468
        OutFile     = "hyphen.html"
        Months      = @("08_Aug'25","09_Sep'25","10_Oct'25","11_Nov'25","12_Dec'25","1_Jan'26","2_Feb'26","3_Mar'26","4_Apr'26","5_May'26","6_Jun'26","7_Jul'26")
        Classes     = @(
            @{ key="Delivery"; id="delivery"; label="Delivery"; color="var(--s1)" },
            @{ key="Warehouse"; id="warehouse"; label="Warehouse"; color="var(--s2)" },
            @{ key="Technical"; id="technical"; label="Technical"; color="var(--s3)" },
            @{ key="Packaging and Operational"; id="packaging"; label="Packaging & Operational"; color="var(--s4)" },
            @{ key="Product"; id="product"; label="Product"; color="var(--s5)" }
        )
        Col = @{ prod=6; batch=7; sku=8; cls=4; cat=5; partner=10; month=12; sales=19; alloc=23; uniq=17;
                 wh=22; lastsource=3; platform=40; visdamage=33; outerpkg=32; statezone=34 }
        SmallTabs = @{ mom="Hyp: MoM"; prodnps="HYP:PRODUCT NPS"; agent="Hyp Agent Chart"; ai="HYP AI Chart" }
    }
)
