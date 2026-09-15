import pytest
from mac_gyver.coordinates import fit_rect, normalized_point, selection_region


def test_retina_preview_keeps_letterbox_outside_touch_target():
    rect = fit_rect(600, 600, 1170, 2532)
    x, y, width, height = rect
    assert normalized_point(x - 1, 300, rect) is None
    assert normalized_point(x + width/2, y + height/2, rect) == {'x':.5, 'y':.5}
    assert normalized_point(x, y, rect) == {'x':0, 'y':0}
    assert normalized_point(x + width, y + height, rect) == {'x':1, 'y':1}
    assert normalized_point(float('nan'), 100, rect) is None


def test_reverse_region_drag_and_accidental_click():
    region = selection_region({'x':.8,'y':.9}, {'x':.2,'y':.1})
    assert region == pytest.approx({'x':.2,'y':.1,'width':.6,'height':.8})
    with pytest.raises(ValueError):
        selection_region({'x':.2,'y':.1}, {'x':.2,'y':.1})


@pytest.mark.parametrize('dimensions', [(0,600,100,200),(600,600,100,float('inf'))])
def test_invalid_screen_dimensions(dimensions):
    with pytest.raises(ValueError):
        fit_rect(*dimensions)
