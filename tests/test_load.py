import pytest

from girder.plugin import loadedPlugins


@pytest.mark.plugin('segverviewer')
def test_import(server):
    assert 'segverviewer' in loadedPlugins()
