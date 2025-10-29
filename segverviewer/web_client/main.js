import { getCurrentUser } from '@girder/core/auth';
import { AccessType } from '@girder/core/constants';
import { restRequest } from '@girder/core/rest';
import events from '@girder/core/events';
import { wrap } from '@girder/core/utilities/PluginUtils';
import { CollectionView } from '@girder/core/views/body';

import DetectImagesItemTemplate from './templates/detectImagesItem.pug';

import SegItemView from './views/SegView';

wrap(CollectionView, 'render', function (render) {
    render.call(this);

    restRequest({
        url: `segmentation/${this.model.id}/is_segverhandler_instance`,
        method: 'GET'
    }).then((resp) => {
        console.log(resp)
        if (!resp) {
            return;
        }
        restRequest({
            url: `segmentation/${this.model.id}/get_index`,
            method: 'GET'
        }).then((index) => {
            restRequest({
                url: `segmentation/${this.model.id}/get_seg_files`,
                method: 'GET'
            }).then((segFiles) => {
                new SegItemView({
                    parentView: this,
                    model: this.model,
                    index: index,
                    segFiles: segFiles
                }).render()
                    .$el.insertAfter(this.$('.g-hierarchy-widget'));
            });
        });
    }, this);

    return this;
});
