"""Build the 256-word lists used for chalk challenges.

Keeps the 256 shortest candidates (ties broken alphabetically), then sorts
alphabetically. Index i in the final list is the word for byte value i.
"""
import json
import pathlib
import re

EN = """
ant apple arrow axe baby badge bag ball banana band bank bat bean bear bed bee bell belt bench berry
bike bird boat bone book boot bottle bowl box bread brick bridge broom brush bucket bus butter cabin
cake camel camera candle candy canoe cap car card carrot castle cat chain chair chalk cheese cherry
chest chicken circle city clock cloud coat coconut coffee coin comb corn cow crab crown cup daisy
deer desk diamond dish dog doll donkey door dove dragon dress drum duck eagle egg elbow engine eye
fan farm feather fence fern field finger fire fish flag flower flute fork fox frog fruit garden gate
ghost gift giraffe glass globe glove goat gold grape grass guitar hammer hand harp hat heart hen hill
honey hook horse house ice igloo ink island jacket jam jar jeep jelly juice kettle key king kite
kitten knife ladder lake lamb lamp leaf lemon letter lion lock map mango maple mask medal melon milk
mirror monkey moon mouse mug nail needle nest net noodle nose nut oak ocean onion orange owl paint
palm pan panda paper parrot peach pear pearl pen pencil pepper piano pig pillow pipe pizza plane
planet plate plum pond pot potato pumpkin puppy queen rabbit radio rain rainbow rake ribbon ring
river road robot rock rocket roof rope rose ruler sail salt sand scarf seed shark sheep shell ship
shirt shoe skirt sky sled snail snake soap sock sofa spider spoon star stone straw sugar sun swan
swing sword table tail tape taxi tea teapot tent thumb ticket tiger toast tomato tooth torch towel
tower toy tractor train tree truck trumpet tulip turtle umbrella van vase violin wagon wall watch
water whale wheel window wing wolf wood yak yarn zebra zipper
"""

# DRAFT: have a native Swahili speaker review before any real pilot.
SW = """
maji jua mti nyumba kitabu shule mwalimu mtoto chakula ndege samaki simba tembo twiga punda mbwa paka
kuku mbuzi kondoo nyoka chui fisi sungura kiboko kobe nyuki kipepeo mvua upepo mlima mto ziwa bahari
jiwe mchanga udongo moto hewa nyota mwezi anga wingu radi barafu ua jani tunda embe ndizi nanasi
chungwa papai nazi mahindi mchele wali ugali mkate maziwa chai kahawa sukari chumvi asali yai nyama
supu maharage viazi karoti kitunguu nyanya pilipili mboga kalamu karatasi daftari ubao chaki meza
kiti dirisha mlango ukuta paa sakafu kitanda taa saa simu redio gari basi baiskeli meli treni
barabara daraja soko duka pesa benki kanisa msikiti hospitali dawa daktari mkulima mvuvi fundi rafiki
mama baba dada kaka bibi babu jirani mgeni mfalme askari kichwa jicho sikio pua mdomo jino ulimi
mkono kidole mguu moyo damu nywele ngozi sauti wimbo ngoma mpira mchezo hadithi jina neno swali jibu
somo darasa rangi nyeupe nyeusi nyekundu kijani njano kubwa ndogo refu fupi safi baridi joto haraka
asubuhi mchana jioni usiku leo kesho jana wiki mwaka siku moja mbili tatu nne tano sita saba nane
tisa kumi ishirini mia elfu kula kunywa kusoma kuandika kucheza kuimba kulala kukimbia kutembea
kusikia kuona kupika kufua kuosha kununua kuuza kujenga kulima kuruka kucheka kulia kupanda kufika
kurudi furaha amani upendo nguvu akili elimu kazi ukweli heshima haki umoja uhuru nchi mji kijiji
shamba msitu jangwa kisiwa pwani bandari uwanja kiwanda ofisi maktaba chuo dereva nahodha kijana mzee
familia harusi sherehe zawadi barua habari picha ramani kofia shati viatu kanzu kitenge mkoba
sanduku kikombe sahani kijiko kisu sufuria jiko ndoo kamba nguo kitambaa sabuni kioo kengele filimbi
gitaa zeze ngamia farasi nguruwe bata njiwa tai bundi kasuku kunguru mamba chura buibui mende siafu
kaa pweza papa nyangumi kiwavi panya popo nyati swala fahali ndama
"""


def build(raw: str) -> list[str]:
    words = sorted(set(raw.split()))
    for w in words:
        assert re.fullmatch(r"[a-z]+", w), w
    assert len(words) >= 256, f"only {len(words)} candidates"
    keep = sorted(words, key=lambda w: (len(w), w))[:256]
    return sorted(keep)


if __name__ == "__main__":
    out = pathlib.Path(__file__).resolve().parents[1] / "wordlists"
    for name, raw in (("en", EN), ("sw", SW)):
        words = build(raw)
        assert len(words) == 256 and len(set(words)) == 256
        (out / f"{name}.json").write_text(json.dumps(words, indent=0) + "\n")
        print(name, len(words), "longest:", max(len(w) for w in words))
