"""Small value conversions shared by model storage and scoring."""

def to_float(value):
    if value is None or value == "":
        return None
    try:
        return float(str(value).replace(",", ""))
    except ValueError:
        return None


def latest_period(periods):
    clean = [p for p in periods if p]
    return sorted(clean)[-1] if clean else ""
