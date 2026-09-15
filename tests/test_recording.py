"""Portable recordings must survive moving folders and exclude editing latency."""
from pathlib import Path
import shutil

import pytest
from PIL import Image

from mac_gyver.models import load_scenario, new_scenario
from mac_gyver.recording import RecordingClock, save_project, walk_steps


def test_clock_only_counts_ready_intervals():
    moment = [0.0]
    clock = RecordingClock(lambda: moment[0])
    clock.resume()
    moment[0] = .15
    clock.pause()
    moment[0] = 12.0  # device response and time spent editing controls
    clock.resume()
    moment[0] = 12.2
    assert clock.take_ms() == 350
    moment[0] = 20
    assert clock.take_ms() == 0
    clock.resume()
    moment[0] = 20.1
    clock.reset()
    assert clock.take_ms() == 0


def project_with_baselines(source):
    Image.new('RGB', (30, 60), '#227799').save(source / 'original.png')
    check = {'type':'assert_image', 'baseline':'original.png',
             'region':{'x':0, 'y':0, 'width':1, 'height':1}}
    scenario = new_scenario()
    scenario['precondition'] = dict(check)
    scenario['setup'] = [dict(check)]
    scenario['steps'] = [{'type':'repeat', 'count':2, 'steps':[dict(check)]}]
    return scenario


def test_save_as_is_portable_and_includes_nested_checks(tmp_path):
    source = tmp_path / 'draft'; source.mkdir()
    scenario = project_with_baselines(source)
    exported = tmp_path / 'export' / 'trip.json'
    saved = save_project(scenario, exported, source)
    assert scenario['precondition']['baseline'] == 'original.png'
    assert len(list(exported.parent.rglob('*.png'))) == 1
    shutil.rmtree(source)
    relocated = tmp_path / 'relocated'
    shutil.move(str(exported.parent), relocated)
    loaded = load_scenario(relocated / 'trip.json')
    for step in walk_steps(loaded):
        if step['type'] == 'assert_image':
            assert (relocated / step['baseline']).is_file()
    # Saving in place must not truncate a baseline whose destination is itself.
    saved_again = save_project(loaded, relocated / 'trip.json', relocated)
    assert saved_again == saved
    assert load_scenario(relocated / 'trip.json') == saved_again


def test_failed_save_preserves_existing_json(tmp_path):
    source = tmp_path / 'draft'; source.mkdir()
    scenario = project_with_baselines(source)
    target = tmp_path / 'saved.json'
    target.write_text('previous version')
    (source / 'original.png').unlink()
    with pytest.raises(ValueError):
        save_project(scenario, target, source)
    assert target.read_text() == 'previous version'


def test_save_rejects_baseline_symlink_outside_project(tmp_path):
    source = tmp_path / 'draft'; source.mkdir()
    scenario = project_with_baselines(source)
    image = source / 'original.png'
    outside = tmp_path / 'outside.png'
    image.rename(outside)
    image.symlink_to(outside)
    with pytest.raises(ValueError):
        save_project(scenario, tmp_path / 'saved.json', source)
