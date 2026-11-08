"""Command-line entry point: ``felinos``."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Annotated

import typer

from felinos_telemetry import __version__

app = typer.Typer(help="Felinos Racing telemetry tools.", no_args_is_help=True)


@app.callback()
def main(
    verbose: Annotated[bool, typer.Option("--verbose", "-v", help="Debug logging.")] = False,
) -> None:
    """Felinos Racing telemetry tools."""
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


@app.command()
def version() -> None:
    """Print the package version."""
    typer.echo(__version__)


@app.command()
def ingest(
    data_dir: Annotated[
        Path | None,
        typer.Option(help="Output folder (default: $FELINOS_DATA_DIR or data/stream)."),
    ] = None,
    env_file: Annotated[Path, typer.Option(help="File with MQTT_* settings.")] = Path(".env"),
    topic: Annotated[str | None, typer.Option(help="Override MQTT_TOPIC.")] = None,
    stats_interval: Annotated[float, typer.Option(help="Seconds between status lines.")] = 5.0,
) -> None:
    """Subscribe to the broker and back up every message to NDJSON (one file per session)."""
    import dataclasses
    import os

    from dotenv import load_dotenv

    from felinos_telemetry.ingest.mqtt_logger import MqttSettings, default_data_dir, run
    from felinos_telemetry.ingest.sinks import NdjsonSink

    if env_file.exists():
        load_dotenv(env_file)
    try:
        settings = MqttSettings.from_env(dict(os.environ))
    except ValueError as exc:
        typer.secho(f"Error: {exc}", fg=typer.colors.RED, err=True)
        raise typer.Exit(2) from exc
    if topic:
        settings = dataclasses.replace(settings, topic=topic)
    out_dir = data_dir or default_data_dir()
    typer.echo(f"felinos ingest -> {out_dir.resolve()}  ({settings.host}, topic {settings.topic})")
    typer.echo("Press Ctrl+C to stop.")
    run(settings, [NdjsonSink(out_dir)], stats_interval=stats_interval, echo=typer.echo)


@app.command()
def check(
    path: Annotated[Path, typer.Argument(help="Sensor Logger export (folder/zip) or .ndjson.")],
) -> None:
    """Quick sanity check of a recording: sensors, sample rate, duration and GPS fixes."""
    from felinos_telemetry.io.ndjson import read_stream
    from felinos_telemetry.io.sensorlogger import read_export

    if not path.exists():
        typer.secho(f"Error: {path} does not exist", fg=typer.colors.RED, err=True)
        raise typer.Exit(2)
    long = read_stream(path) if path.suffix == ".ndjson" else read_export(path)
    if long.empty:
        typer.secho("No sensor data found.", fg=typer.colors.YELLOW)
        raise typer.Exit(1)
    typer.echo(f"{'sensor':<28}{'samples':>9}{'duration s':>12}{'rate Hz':>10}")
    for sensor, group in long.groupby("sensor"):
        t = group["time_ns"].drop_duplicates().sort_values()
        dur = (t.iloc[-1] - t.iloc[0]) / 1e9
        rate = (len(t) - 1) / dur if dur > 0 else 0.0
        typer.echo(f"{sensor!s:<28}{len(t):>9}{dur:>12.1f}{rate:>10.1f}")


@app.command()
def simulate(
    export: Annotated[Path, typer.Argument(help="Sensor Logger CSV export (folder or zip).")],
    out: Annotated[
        Path | None, typer.Option(help="Write an NDJSON file (for the dashboard ?demo=).")
    ] = None,
    publish: Annotated[bool, typer.Option(help="Publish to the broker in real time.")] = False,
    speed: Annotated[float, typer.Option(help="Playback speed when publishing.")] = 1.0,
    env_file: Annotated[Path, typer.Option(help="File with MQTT_* settings.")] = Path(".env"),
    device_id: Annotated[str, typer.Option(help="deviceId to use in messages.")] = "simulator",
) -> None:
    """Replay a recording as Sensor Logger MQTT messages (rehearse without the car)."""
    import os

    from felinos_telemetry.io.ndjson import write_records
    from felinos_telemetry.io.sensorlogger import read_export
    from felinos_telemetry.simulate import export_to_messages, pace, to_records

    if not out and not publish:
        typer.secho("Error: use --out and/or --publish", fg=typer.colors.RED, err=True)
        raise typer.Exit(2)
    messages = list(export_to_messages(read_export(export), device_id=device_id))
    if not messages:
        typer.secho("No sensor data found.", fg=typer.colors.YELLOW)
        raise typer.Exit(1)
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.unlink(missing_ok=True)
        write_records(out, to_records(messages, "felinos"))
        typer.echo(f"wrote {len(messages)} messages to {out}")
    if publish:
        import json

        from dotenv import load_dotenv

        from felinos_telemetry.ingest.mqtt_logger import MqttSettings, connect_publisher

        if env_file.exists():
            load_dotenv(env_file)
        try:
            settings = MqttSettings.from_env(dict(os.environ))
        except ValueError as exc:
            typer.secho(f"Error: {exc}", fg=typer.colors.RED, err=True)
            raise typer.Exit(2) from exc
        client = connect_publisher(settings)
        prefix = settings.topic.rstrip("#").rstrip("/") or "felinos"

        def send(m: dict[str, object]) -> None:
            client.publish(f"{prefix}/{m['deviceId']}/{m['sessionId']}", json.dumps(m), qos=0)
            typer.echo(f"published message {m['messageId']}/{len(messages)}")

        try:
            pace(messages, send, speed=speed)
        finally:
            client.disconnect()
            client.loop_stop()


@app.command()
def dashboard(
    port: Annotated[int, typer.Option(help="Local port.")] = 8000,
    directory: Annotated[
        Path | None, typer.Option(help="Dashboard folder (default: repo dashboard/).")
    ] = None,
    open_browser: Annotated[bool, typer.Option("--open/--no-open")] = True,
) -> None:
    """Serve the dashboard locally (ES modules do not load from file://)."""
    import webbrowser

    from felinos_telemetry.serve import make_server

    folder = directory or Path(__file__).resolve().parents[2] / "dashboard"
    if not (folder / "index.html").exists():
        typer.secho(f"Error: no index.html in {folder}", fg=typer.colors.RED, err=True)
        raise typer.Exit(2)
    with make_server(folder, port) as httpd:
        url = f"http://localhost:{port}/"
        typer.echo(f"Dashboard at {url}  (Ctrl+C to stop)")
        if open_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            typer.echo("stopping...")


REPO_ROOT = Path(__file__).resolve().parents[2]


def _find_export(run_dir: Path) -> Path | None:
    """sensorlogger.zip, any other zip, or a folder holding the CSVs (the run folder itself)."""
    preferred = run_dir / "sensorlogger.zip"
    if preferred.exists():
        return preferred
    zips = sorted(run_dir.glob("*.zip"))
    if zips:
        return zips[0]
    if (run_dir / "Accelerometer.csv").exists():
        return run_dir
    folders = [p for p in run_dir.iterdir() if p.is_dir() and (p / "Accelerometer.csv").exists()]
    return folders[0] if folders else None


@app.command()
def analyze(
    run_dir: Annotated[Path, typer.Argument(help="Run folder (meta.yaml + Sensor Logger export).")],
    export: Annotated[
        Path | None, typer.Option(help="Export zip/folder if not inside the run folder.")
    ] = None,
    config_dir: Annotated[
        Path, typer.Option(help="Folder with analysis.yaml, requirements.yaml, vehicles/.")
    ] = REPO_ROOT / "config",
) -> None:
    """Analyze a run: writes results/summary.json, events.csv and report.md."""
    from felinos_telemetry.analysis.run import analyze as analyze_run
    from felinos_telemetry.io.sensorlogger import read_export
    from felinos_telemetry.models import (
        load_analysis_config,
        load_requirements,
        load_run_meta,
        load_vehicle_config,
    )
    from felinos_telemetry.reporting.run_report import write_results

    src = export or _find_export(run_dir)
    if src is None or not src.exists():
        typer.secho(
            f"Error: no Sensor Logger export found in {run_dir}", fg=typer.colors.RED, err=True
        )
        raise typer.Exit(2)
    meta_path = run_dir / "meta.yaml"
    meta = load_run_meta(meta_path) if meta_path.exists() else None
    if meta is None:
        typer.secho(
            "Warning: no meta.yaml; using defaults (test type 'free').", fg=typer.colors.YELLOW
        )
    vehicle = None
    if meta is not None:
        vpath = config_dir / "vehicles" / f"{meta.vehicle_id}.yaml"
        vehicle = load_vehicle_config(vpath) if vpath.exists() else None
    cfg_path = config_dir / "analysis.yaml"
    req_path = config_dir / "requirements.yaml"
    summary = analyze_run(
        read_export(src),
        meta=meta,
        vehicle=vehicle,
        config=load_analysis_config(cfg_path) if cfg_path.exists() else None,
        requirements=load_requirements(req_path) if req_path.exists() else [],
    )
    paths = write_results(summary, run_dir / "results")
    u = summary["usage"]
    typer.echo(
        f"active {u['active_s']:.0f} s | {u['distance_km']:.2f} km"
        f" | events {summary['events']['counts']}"
    )
    for g in summary["goals"]:
        value = "-" if g["value"] is None else f"{g['value']:.2f}"
        verdict = {None: "no data", True: "PASS", False: "FAIL"}[g["pass"]]
        typer.echo(f"{g['id']} {g['metric']}: {value} ({g['criterion']}) {verdict}")
    typer.echo(f"wrote {paths['report']}")


@app.command()
def usage(
    data_dir: Annotated[Path, typer.Argument(help="Data folder with analyzed runs.")] = Path(
        "data"
    ),
    target_hours: Annotated[float, typer.Option(help="VG-02 durability target.")] = 80.0,
    csv_out: Annotated[
        Path | None, typer.Option("--csv", help="Also write the table as CSV.")
    ] = None,
) -> None:
    """Accumulated active hours, distance, impacts and damage across all analyzed runs (VG-02)."""
    import csv as csv_mod
    from dataclasses import asdict

    from felinos_telemetry.reporting.usage import collect

    if not data_dir.exists():
        typer.secho(f"Error: {data_dir} does not exist", fg=typer.colors.RED, err=True)
        raise typer.Exit(2)
    totals = collect(data_dir)
    if not totals.runs:
        typer.secho(
            "No analyzed runs found (run `felinos analyze <run_dir>` first).",
            fg=typer.colors.YELLOW,
        )
        raise typer.Exit(1)
    typer.echo(f"{'run':<44}{'test':<14}{'active h':>9}{'km':>8}{'impacts':>9}{'eq h':>7}")
    for r in totals.rows:
        eq = "-" if r.equivalent_h is None else f"{r.equivalent_h:.2f}"
        typer.echo(
            f"{r.run_dir[:43]:<44}{r.test_type:<14}{r.active_h:>9.3f}{r.distance_km:>8.2f}{r.impacts:>9}{eq:>7}"
        )
    eq_total = (
        "- (set durability.reference_damage_per_hour)"
        if totals.equivalent_h is None
        else f"{totals.equivalent_h:.2f} h"
    )
    typer.echo(
        f"\nTOTAL {totals.runs} runs | active {totals.active_h:.2f} h of {target_hours:g} h"
        f" ({totals.progress(target_hours):.1%}) | {totals.distance_km:.1f} km"
        f" | impacts {totals.impacts}"
        f" | equivalent {eq_total}"
    )
    if csv_out:
        with csv_out.open("w", newline="", encoding="utf-8") as fh:
            rows = [asdict(r) for r in totals.rows]
            writer = csv_mod.DictWriter(fh, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        typer.echo(f"wrote {csv_out}")
