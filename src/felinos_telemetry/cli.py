"""Command-line entry point: ``felinos``."""

import typer

from felinos_telemetry import __version__

app = typer.Typer(help="Felinos Racing telemetry tools.", no_args_is_help=True)


@app.callback()
def main() -> None:
    """Felinos Racing telemetry tools."""


@app.command()
def version() -> None:
    """Print the package version."""
    typer.echo(__version__)
