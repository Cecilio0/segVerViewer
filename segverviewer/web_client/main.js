import { getCurrentUser } from '@girder/core/auth';
import { AccessType } from '@girder/core/constants';
import { restRequest } from '@girder/core/rest';
import events from '@girder/core/events';
import { wrap } from '@girder/core/utilities/PluginUtils';
import { CollectionView } from '@girder/core/views/body';

import DetectImagesItemTemplate from './templates/detectImagesItem.pug';

import SegItemView from './views/SegView';

console.log('Loaded SegVerViewer!');

wrap(CollectionView, 'render', function (render) {
    this.once('g:rendered', () => {
        console.log('[SegVerViewer] Checking if item has segverhandler instance...');
        console.log(this.model);
        restRequest({
            url: `segmentation/${this._id}/is_segverhandler_instance`,
            method: 'GET'
        }).then((resp) => {
            console.log(resp)
            if (!resp) {
                return;
            }
            restRequest({
                url: `segmentation/${this._id}/get_index`,
                method: 'GET'
            }).then((index) => {
                restRequest({
                    url: `segmentation/${this._id}/get_all_index_files`,
                    method: 'GET'
                }).then((allIndexFiles) => {
                    new SegItemView({
                        parentView: this,
                        item: this.model,
                        index: index,
                        allIndexFiles: allIndexFiles
                    }).render()
                        .$el.insertAfter(this.$('.g-item-info'));
                });
            });
        });
    }, this);

    render.call(this);

    return this;
});

// Needed for the time being
// Detect images button logic
// ItemView.prototype.events['click .g-detect-images-item'] = function () {
//     restRequest({
//         method: 'POST',
//         url: `item/${this.model.id}/detect_images`,
//         error: null
//     })
//         .done((resp) => {
//             // Show up a message to alert the user it was done
//             events.trigger('g:alert', {
//                 icon: 'ok',
//                 text: 'Images within item detected successfully.',
//                 type: 'success',
//                 timeout: 4000
//             });
//         })
//         .fail((resp) => {
//             events.trigger('g:alert', {
//                 icon: 'cancel',
//                 text: 'Could not detect images.',
//                 type: 'danger',
//                 timeout: 4000
//             });
//         });
// };
