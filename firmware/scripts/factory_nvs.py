Import("env")

import csv
import subprocess
from pathlib import Path

MAX_DEVICE_NAME_BYTES = 28


def parse_size(value):
    value = value.strip().lower()
    multiplier = 1
    if value.endswith("k"):
        multiplier = 1024
        value = value[:-1]
    elif value.endswith("m"):
        multiplier = 1024 * 1024
        value = value[:-1]
    return int(value, 0) * multiplier


def find_nvs_partition(partition_table_path):
    matches = []
    with partition_table_path.open(newline="", encoding="utf-8-sig") as partition_table:
        for row in csv.reader(partition_table):
            fields = [field.strip() for field in row]
            if not fields or not fields[0] or fields[0].startswith("#"):
                continue
            if len(fields) < 5:
                raise RuntimeError(f"Invalid partition table row: {row}")
            if fields[1] == "data" and fields[2] == "nvs":
                matches.append(fields)

    if len(matches) != 1:
        raise RuntimeError(
            f"Expected exactly one NVS partition in {partition_table_path}, found {len(matches)}"
        )

    partition = matches[0]
    if not partition[3]:
        raise RuntimeError(
            f"The NVS partition in {partition_table_path} must have an explicit offset"
        )
    return parse_size(partition[3]), parse_size(partition[4])


def validate_device_name(nvs_csv_path):
    with nvs_csv_path.open(newline="", encoding="utf-8-sig") as nvs_csv:
        rows = list(csv.DictReader(nvs_csv))

    matches = [row for row in rows if row.get("key", "").strip() == "device_name"]
    if len(matches) != 1:
        raise RuntimeError(
            f"Expected exactly one device_name setting in {nvs_csv_path}, found {len(matches)}"
        )

    row = matches[0]
    if row.get("type", "").strip() != "data" or row.get("encoding", "").strip() != "string":
        raise RuntimeError("device_name must use type=data and encoding=string")

    device_name = row.get("value", "")
    if len(device_name.encode("utf-8")) > MAX_DEVICE_NAME_BYTES:
        raise RuntimeError(
            f"device_name must contain at most {MAX_DEVICE_NAME_BYTES} UTF-8 bytes"
        )


project_dir = Path(env.subst("$PROJECT_DIR"))
nvs_csv_path = project_dir / env.GetProjectOption("custom_nvs_csv")
nvs_bin_path = Path(env.subst("$BUILD_DIR")) / "factory_nvs.bin"
partition_table_path = Path(env.subst("$PARTITIONS_TABLE_CSV"))
nvs_offset, nvs_size = find_nvs_partition(partition_table_path)

def generate_nvs(source, target, env):
    if not nvs_csv_path.is_file():
        raise RuntimeError(
            f"Missing {nvs_csv_path}. Copy nvs.example.csv to nvs.csv and fill in the settings."
        )
    validate_device_name(nvs_csv_path)
    nvs_bin_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Generating factory NVS image: {nvs_bin_path}")
    subprocess.run(
        [
            env.subst("$PYTHONEXE"),
            "-m",
            "esp_idf_nvs_partition_gen",
            "generate",
            str(nvs_csv_path),
            str(nvs_bin_path),
            hex(nvs_size),
        ],
        check=True,
    )


if env.subst("$UPLOAD_PROTOCOL") != "esptool":
    raise RuntimeError("Factory NVS upload requires the esptool upload protocol")

env.AddPreAction("upload", generate_nvs)
env.Append(UPLOADERFLAGS=[hex(nvs_offset), str(nvs_bin_path)])
