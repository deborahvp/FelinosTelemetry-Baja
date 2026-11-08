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
