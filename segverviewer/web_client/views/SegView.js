import vtkImageSlice from 'vtk.js/Sources/Rendering/Core/ImageSlice';
import vtkImageData from 'vtk.js/Sources/Common/DataModel/ImageData';
import vtkPiecewiseFunction from 'vtk.js/Sources/Common/DataModel/PiecewiseFunction';
import vtkDataArray from 'vtk.js/Sources/Common/Core/DataArray';
import vtkImageMapper from 'vtk.js/Sources/Rendering/Core/ImageMapper';
import vtkColorTransferFunction from 'vtk.js/Sources/Rendering/Core/ColorTransferFunction';
import vtkInteractorStyleImage from 'vtk.js/Sources/Interaction/Style/InteractorStyleImage';
import vtkOpenGLRenderWindow from 'vtk.js/Sources/Rendering/OpenGL/RenderWindow';
import vtkRenderer from 'vtk.js/Sources/Rendering/Core/Renderer';
import vtkRenderWindow from 'vtk.js/Sources/Rendering/Core/RenderWindow';
import vtkRenderWindowInteractor from 'vtk.js/Sources/Rendering/Core/RenderWindowInteractor';

import { restRequest } from '@girder/core/rest';
import FileModel from '@girder/core/models/FileModel';
import FileCollection from '@girder/core/collections/FileCollection';
import View from '@girder/core/views/View';

import SegItemTemplate from '../templates/segItem.pug';
import '../stylesheets/segItem.styl';

const ImageFileModel = FileModel.extend({
    getFileInfo: function () {
        if (!this._tag || !this._comment) {
            return restRequest({
                url: `/file/${this.id}`,
                method: 'GET',
            })
                .then((resp) => {
                    this._tag = resp.tag;
                    this._comment = resp.comment;
                    return resp;
                });
        }
        return Promise.resolve({ tag: this._tag, comment: this._comment });
    },
    getImage: function (slice, isSeg, diffInfo, volume_id) {
        if (!this._image) {
            // Cache the slice on the model
            if (isSeg) {
                return restRequest({
                    url: `/segmentation/segmentation_data/?seg_id=${this.id}&volume_id=${volume_id}`,
                    method: 'GET',
                })
                    .then((resp) => {
                        this._image = resp;
                        const slicedResp = Object.assign({}, resp);
                        slicedResp.data = resp.data[slice];
                        return slicedResp;
                    });
            } else if (diffInfo) {
                // diffInfo should contain seg1_id and seg2_id
                return restRequest({
                    url: `/segmentation/diff_data/?seg1_id=${diffInfo.seg1_id}&seg2_id=${diffInfo.seg2_id}`,
                    method: 'GET',
                })
                    .then((resp) => {
                        console.log('[ImageFileModel::getImage] diff called with response: ', resp);
                        this._image = resp;
                        const slicedResp = Object.assign({}, resp);
                        slicedResp.data = resp.data[slice];
                        return slicedResp;
                    });
            } else {
                return restRequest({
                    url: `/segmentation/${this.id}/base_image_data`,
                    method: 'GET',
                })
                    .then((resp) => {
                        console.log('[ImageFileModel::getImage] base called with response of length: ', resp);
                        this._image = resp;
                        const slicedResp = Object.assign({}, resp);
                        slicedResp.data = resp.data[slice];
                        return slicedResp;
                    });
            }
        }
        
        // When image is cached, return a resolved Promise to maintain consistency
        console.log('[ImageFileModel::getImage] this._image: ', this._image);
        const slicedResp = Object.assign({}, this._image);
        slicedResp.data = this._image.data[slice];
        return Promise.resolve(slicedResp);
    },
    getSliceCount: function () {
        return this._image.data.length;
    },
    setTag: function (tag) {
        restRequest({
            url: `/file/${this.id}/set_seg_tag`,
            method: 'POST',
            data: { tag: tag }
        }).then(() => {
            this._tag = tag;
        });
    },
    setComment: function (comment) {
        restRequest({
            url: `/file/${this.id}/set_seg_comment`,
            method: 'POST',
            data: { comment: comment }
        }).then(() => {
            this._comment = comment;
        });
    }
});

const ImageFileCollection = FileCollection.extend({
    model: ImageFileModel,
    initialize: function () {
        FileCollection.prototype.initialize.apply(this, arguments);

        this._selectedVolume = 0;
        this._selectedSeg1 = 0;
        this._selectedLabel1 = -1;
        this._selectedSeg2 = 1;
        this._selectedLabel2 = -1;
    },
    selectVolumeIndex: function (index) {
        console.log('[ImageFileCollection::selectVolumeIndex] called with index: ', index);
        this._selectedVolume = index;
        this.trigger('g:selected-volume', this.at(index));
    },
    selectSeg1Index: function (index) {
        console.log('[ImageFileCollection::selectSeg1Index] called with index: ', index);
        this._selectedSeg1 = index;
        this.trigger('g:selected-seg-1', this.at(index), this._selectedLabel1);
    },
    selectSeg2Index: function (index) {
        console.log('[ImageFileCollection::selectSeg2Index] called with index: ', index);
        this._selectedSeg2 = index;
        this.trigger('g:selected-seg-2', this.at(index), this._selectedLabel2);
    },
    selectLabel1Index: function (index) {
        console.log('[ImageFileCollection::selectLabel1Index] called with index: ', index);
        this._selectedLabel1 = index;
        this.trigger('g:selected-seg-1', this.at(this._selectedSeg1), index);
    },
    selectLabel2Index: function (index) {
        console.log('[ImageFileCollection::selectLabel2Index] called with index: ', index);
        this._selectedLabel2 = index;
        this.trigger('g:selected-seg-2', this.at(this._selectedSeg2), index);
    }
});

const SegImageWidget = View.extend({
    className: 'g-seg',
    initialize: function (settings) {
        console.log('[SegImageWidget::initialize] settings: ', settings);
        this._image = null;
        this._labelValue = -1; // Initialize on all labels
        this._slice = 0;
        this.vtk = {
            renderer: null,
            actor: null,
            camera: null,
            interactor: null
        };
    },
    destroy: function () {
        if (this.vtk.interactor) {
            this.vtk.interactor.unbindEvents(this.el);
        }
        View.prototype.destroy.apply(this, arguments);
    },
    setImage: function (image) {
        this._image = image;
        return this;
    },
    setLabelValue: function (labelValue) {
        console.log('[SegImageWidget::setLabelValue] labelValue: ', labelValue);
        this._labelValue = labelValue;
        return this;
    },
    /**
     * Do a full render.
     *
     * May be called without calling `setSlice` first.
     */
    render: function () {
        this.vtk.renderer = vtkRenderer.newInstance();
        this.vtk.renderer.setBackground(0.33, 0.33, 0.33);

        const renWin = vtkRenderWindow.newInstance();
        renWin.addRenderer(this.vtk.renderer);

        const glWin = vtkOpenGLRenderWindow.newInstance();
        glWin.setContainer(this.el);
        glWin.setSize(256, 256);
        renWin.addView(glWin);

        this.vtk.interactor = vtkRenderWindowInteractor.newInstance();
        const style = vtkInteractorStyleImage.newInstance();
        this.vtk.interactor.setInteractorStyle(style);
        this.vtk.interactor.setView(glWin);

        this.vtk.actor = vtkImageSlice.newInstance();
        this.vtk.renderer.addActor(this.vtk.actor);

        if (this._image) {
            const mapper = vtkImageMapper.newInstance();
            if (this._image.labels) {
                console.log('[SegImageWidget::render] getProperty: ', this.vtk.actor.getProperty());
                console.log('[SegImageWidget::render] getProperty.getRGBTransferFunction: before', this.vtk.actor.getProperty().getRGBTransferFunction());
                this.vtk.actor.getProperty().setRGBTransferFunction(0, this._getColorFun());
                console.log('[SegImageWidget::render] getProperty.getRGBTransferFunction: after', this.vtk.actor.getProperty().getRGBTransferFunction());
                this.vtk.actor.getProperty().getRGBTransferFunction();
                this.vtk.actor.getProperty().setScalarOpacity(0, this._getOpacityFun());
                // this.vtk.actor.getProperty().setUseLookupTableScalarRange(true);
                this.vtk.actor.getProperty().setInterpolationTypeToLinear();
                // this.vtk.actor.getProperty().setUseLabelOutline(true);
            }
            mapper.setInputData(this._getImageData());
            console.log('[SegImageWidget::render] mapper: ', mapper);
            this.vtk.actor.setMapper(mapper);
            console.log('[SegImageWidget::render] this.vtk.actor: ', this.vtk.actor);
        }

        this.vtk.camera = this.vtk.renderer.getActiveCameraAndResetIfCreated();
        this.vtk.interactor.initialize();
        this.vtk.interactor.bindEvents(this.el);
        this.vtk.interactor.start();

        this.autoLevels(false);
        this.autoZoom(false);
        this.vtk.interactor.render();

        return this;
    },
    /**
     * Cheaply update the rendering, usually after `setSlice` is called.
     */
    rerenderSlice: function () {
        if (this.vtk.renderer) {
            if (this._image) {
                const mapper = vtkImageMapper.newInstance();
                mapper.setInputData(this._getImageData());
                this.vtk.actor.setMapper(mapper);
                if (this._image.labels) {
                    this.vtk.actor.getProperty().setRGBTransferFunction(0, this._getColorFun());
                    this.vtk.actor.getProperty().setScalarOpacity(0, this._getOpacityFun());
                    // this.vtk.actor.getProperty().setUseLookupTableScalarRange(true);
                    this.vtk.actor.getProperty().setInterpolationTypeToNearest();
                    // this.vtk.actor.getProperty().setUseLabelOutline(true);
                }
            }
            this.autoLevels(false);
            this.autoZoom(false);
            this.vtk.interactor.render();
        } else {
            this.render();
        }
        return this;
    },
    /**
     * Requires `render` to be called first.
     */
    autoLevels: function (rerender = true) {
        const range = this._getImageData().getPointData().getScalars().getRange();
        const ww = range[1] - range[0];
        const wc = (range[0] + range[1]) / 2;
        this.vtk.actor.getProperty().setColorWindow(ww);
        this.vtk.actor.getProperty().setColorLevel(wc);

        if (rerender) {
            this.vtk.interactor.render();
        }
        return this;
    },
    /**
     * Requires `render` to be called first.
     */
    autoZoom: function (rerender = true) {
        this.vtk.renderer.resetCamera();
        this.vtk.camera.zoom(1.44);

        const up = [0, -1, 0];
        const pos = this.vtk.camera.getPosition();
        pos[2] = -Math.abs(pos[2]);
        this.vtk.camera.setViewUp(up[0], up[1], up[2]);
        this.vtk.camera.setPosition(pos[0], pos[1], pos[2]);

        if (rerender) {
            this.vtk.interactor.render();
        }
        return this;
    },
    /**
     * Requires `render` to be called first.
     */
    zoomIn: function () {
        this.vtk.camera.zoom(9 / 8);
        this.vtk.interactor.render();
        return this;
    },
    /**
     * Requires `render` to be called first.
     */
    zoomOut: function () {
        this.vtk.camera.zoom(8 / 9);
        this.vtk.interactor.render();
        return this;
    },
    _getColorFun: function () {
        const colorFun = vtkColorTransferFunction.newInstance();
        colorFun.addRGBPoint(0, 0, 0, 0); // background
        console.log('[SegImageWidget::_getColorFun] adding labels: ', this._image.labels);
        for (let i = 0; i < this._image.labels.length; i++) {
            colorFun.addRGBPoint(
                this._image.labels[i].value,
                this._image.labels[i].color[0],
                this._image.labels[i].color[1],
                this._image.labels[i].color[2],
            );
        }
        return colorFun;
    },
    _getOpacityFun: function () {
        const opacityFun = vtkPiecewiseFunction.newInstance();
        opacityFun.addPoint(0, 0); // background
        console.log('[SegImageWidget::_getOpacityFun] adding labels: ', this._image.labels);
        for (let i = 0; i < this._image.labels.length; i++) {
            opacityFun.addPoint(
                this._image.labels[i].value,
                0.7
            );
        }
        return opacityFun;
    },
    _getImageData: function () {
        let tags;
        if (!SegImageWidget.imageDataCache.has(this._image)) {
            tags = this._extractImageData();
            console.log('[SegImageWidget::_getImageData] caching tags for image: ', this._image);
            SegImageWidget.imageDataCache.set(this._image, new Map());
            SegImageWidget.imageDataCache.get(this._image).set(this._labelValue, tags);
        } else if (!SegImageWidget.imageDataCache.get(this._image).has(this._labelValue)) {
            tags = this._extractImageData();
            console.log('[SegImageWidget::_getImageData] caching tags for label: ', this._labelValue);
            SegImageWidget.imageDataCache.get(this._image).set(this._labelValue, tags);
        } else {
            tags = SegImageWidget.imageDataCache.get(this._image).get(this._labelValue);
        }
        return tags;
    },
    _extractImageData: function () {
        console.log('[SegImageWidget::_extractImageData] this._image: ', this._image);

        const imageData = vtkImageData.newInstance();
        imageData.setOrigin(0, 0, 0);
        imageData.setSpacing(this._image.spacing);
        imageData.setExtent(0, this._image.shape[0] -1, 0, this._image.shape[1] - 1, 0, 1);
        let filteredImage = this._image.data;
        if(this._labelValue !== -1) {
            filteredImage = filteredImage.map(
                (value) => value !== this._labelValue ? 0 : value
            );
        }
        console.log('[SegImageWidget::_extractImageData] filtered image unique values: ', new Set(filteredImage), 'with label: ', this._labelValue, 'and size: ', filteredImage.length);

        const dataArray = vtkDataArray.newInstance({
            values: filteredImage,
            numberOfComponents: 1 // Handle grayscale or RGB images
        });
        
        imageData.getPointData().setScalars(dataArray);
        return imageData;
    }
}, {
    // This weakmap will contain other weakmaps to reference images for specific labels
    imageDataCache: new WeakMap()
});

const SegItemView = View.extend({
    className: 'g-view',
    events: {
        'click .g-volume-options a': function (event) {
            event.preventDefault();
            const index = parseInt($(event.target).data('index'));
            this._volumeFiles.selectVolumeIndex(index);
            this._updateDropdownText('.g-volume-dropdown', $(event.target).text());
        },
        'click .g-seg1-options a': function (event) {
            event.preventDefault();
            if ($(event.target).hasClass('disabled')) return;
            const index = parseInt($(event.target).data('index'));
            this._files.selectSeg1Index(index);
            this._updateDropdownText('.g-seg1-dropdown', $(event.target).text());
        },
        'click .g-seg2-options a': function (event) {
            event.preventDefault();
            if ($(event.target).hasClass('disabled')) return;
            const index = parseInt($(event.target).data('index'));
            this._files.selectSeg2Index(index);
            this._updateDropdownText('.g-seg2-dropdown', $(event.target).text());
        },
        'change .g-seg1-tag': function (event) {
            const newTag = $(event.target).val();
            if (this._seg1File) {
                this._seg1File.setTag(newTag);
            }
        },
        'change .g-seg1-comment': function (event) {
            const newComment = $(event.target).val();
            if (this._seg1File) {
                this._seg1File.setComment(newComment);
            }
        },
        'change .g-seg2-tag': function (event) {
            const newTag = $(event.target).val();
            if (this._seg2File) {
                this._seg2File.setTag(newTag);
            }
        },
        'change .g-seg2-comment': function (event) {
            const newComment = $(event.target).val();
            if (this._seg2File) {
                this._seg2File.setComment(newComment);
            }
        },
        'click .g-label1-options a': function (event) {
            event.preventDefault();
            const index = parseInt($(event.target).data('label'));
            this._files.selectLabel1Index(index);
            this._updateDropdownText('.g-label1-dropdown', $(event.target).text());
        },
        'click .g-label2-options a': function (event) {
            event.preventDefault();
            const index = parseInt($(event.target).data('label'));
            this._files.selectLabel2Index(index);
            this._updateDropdownText('.g-label2-dropdown', $(event.target).text());
        },
        'input .g-slice-slider': function (event) {
            const slice = parseInt($(event.target).val());
            this._slice = slice;
            this.$('.g-slice-value').val(slice);
            this._rerender();
        },
        'change .g-slice-value': function (event) {
            let slice = parseInt($(event.target).val());
            if (isNaN(slice)) slice = 0;
            const max = parseInt($(event.target).attr('max'));
            if (slice < 0) slice = 0;
            if (slice > max) slice = max;
            this._slice = slice;
            this.$('.g-slice-slider').val(slice);
            this.$('.g-slice-value').val(slice);
            this._rerender();
        },
        'click .g-seg-zoom-in': function (event) {
            event.preventDefault();
            this._seg1View.zoomIn();
            this._seg2View.zoomIn();
            this._baseImageView.zoomIn();
            this._diffView.zoomIn();
        },
        'click .g-seg-zoom-out': function (event) {
            event.preventDefault();
            this._seg1View.zoomOut();
            this._seg2View.zoomOut();
            this._baseImageView.zoomOut();
            this._diffView.zoomOut();
        },
        'click .g-seg-reset-zoom': function (event) {
            event.preventDefault();
            this._seg1View.autoZoom();
            this._seg2View.autoZoom();
            this._baseImageView.autoZoom();
            this._diffView.autoZoom();
        },
        'click .g-seg-auto-levels': function (event) {
            event.preventDefault();
            this._seg1View.autoLevels();
            this._seg2View.autoLevels();
            this._baseImageView.autoLevels();
            this._diffView.autoLevels();
        }
    },
    /**
     *
     * @param {ItemModel} settings.item An item with its `dicom` attribute set.
     */
    initialize: function (settings) {
        this._id = settings.item.id;
        this._id = '6871135d7be2d603fa63f950';
        this._files = new ImageFileCollection(settings.item.get('segmentation').images || []);
        this._volumeFiles = new ImageFileCollection([]);
        this._baseImageFile = null;
        this._seg1File = null;
        this._seg2File = null;

        this._seg1View = null;
        this._baseImageView = null;
        this._seg2View = null;
        this._diffView = null;

        this._sliceCount = null;
        this._slice = 0;

        this.listenTo(this._volumeFiles, 'g:selected-volume', this._onBaseImageSelectionChanged);
        this.listenTo(this._files, 'g:selected-seg-1', this._onSeg1SelectionChanged);
        this.listenTo(this._files, 'g:selected-seg-2', this._onSeg2SelectionChanged);
    },
    render: function () {
        this.$el.html(
            SegItemTemplate({})
        );

        // base image related
        this._baseImageView = new SegImageWidget({
            el: this.$('.g-base'),
            parentView: this
        });

        restRequest({
            url: `segmentation/${this._id}/get_volumes`,
            method: 'GET'
        }).then((resp) => {
            console.log('[SegItemView::render] volume files response: ', resp);
            this._volumeFiles.add(resp, { merge: true });
            console.log('[SegItemView::render] volume files collection: ', this._volumeFiles);
            console.log('[SegItemView::render] segmentation files collection: ', this._files);

            this._populateVolumeDropdown();
        
            if (this._volumeFiles.length > 0) {
                this._volumeFiles.selectVolumeIndex(this._volumeFiles._selectedVolume);
            }
        });

        // Populate dropdowns with segmentation files
        this._populateSegDropdowns();

        this._seg1View = new SegImageWidget({
            el: this.$('.g-seg-1'),
            parentView: this
        });

        if (this._files.length > 0) {
            this._files.selectSeg1Index(this._files._selectedSeg1);
        }

        this._seg2View = new SegImageWidget({
            el: this.$('.g-seg-2'),
            parentView: this
        });

        if (this._files.length > 1) {
            this._files.selectSeg2Index(this._files._selectedSeg2);
        }

        this._diffView = new SegImageWidget({
            el: this.$('.g-seg-diff'),
            parentView: this
        });

        this._setDiffImage();

        return this;
    },
    _onSeg1SelectionChanged: function (selectedFile, labelValue) {
        let isNewFile = false;
        if (selectedFile != this._seg1File) {
            console.log('[SegItemView::_onSeg1SelectionChanged] called with file:', selectedFile, 'and tag:', selectedFile.tag);
            isNewFile = true;
            this._seg1File = selectedFile;
        }
        // selectedFile.getImage(this._slice, true, null, this._baseImageFile.id)
        selectedFile.getImage(this._slice, true, null, '688974467133106ae84a09af')
            .then((image) => {
                if (isNewFile) {
                    this._populateSegDropdowns();
                    this._populateLabelDropdowns(image, '.g-label1-options', '.g-label1-dropdown');
                    this._seg1View.$('.g-filename').text(selectedFile.name()).attr('title', selectedFile.name());
                    // this._seg1View.$('.g-seg1-tag').text(selectedFile.tag()).attr('title', selectedFile.tag());

                    // update seg quantification
                    this.$('.g-quant1-min').text(image['quantification']['min']);
                    this.$('.g-quant1-max').text(image['quantification']['max']);
                    this.$('.g-quant1-mean').text(image['quantification']['mean']);
                    this.$('.g-quant1-sd').text(image['quantification']['sd']);
                    this.$('.g-quant1-volume').text(image['quantification']['volume']);
                }

                this._seg1View
                    .setImage(image)
                    .setLabelValue(labelValue)
                    .rerenderSlice();

                this._updateDiffImageIfReady();
            });
        if (isNewFile) {
            this._updateSegmentationInfo(selectedFile, '.g-seg1-tag', '.g-seg1-comment');
        }
    },
    _onSeg2SelectionChanged: function (selectedFile, labelValue) {
        let isNewFile = false;
        if (selectedFile != this._seg2File) {
            isNewFile = true;
            this._seg2File = selectedFile;
        }
        // selectedFile.getImage(this._slice, true, null, this._baseImageFile.id)
        selectedFile.getImage(this._slice, true, null, '688974467133106ae84a09af')
            .then((image) => {
                if (isNewFile) {
                    // update only if a new file is selected
                    this._populateSegDropdowns();
                    this._populateLabelDropdowns(image, '.g-label2-options', '.g-label2-dropdown');
                    this._seg2View.$('.g-filename').text(selectedFile.name()).attr('title', selectedFile.name());
                    
                    // update seg quantification
                    this.$('.g-quant2-min').text(image['quantification']['min']);
                    this.$('.g-quant2-max').text(image['quantification']['max']);
                    this.$('.g-quant2-mean').text(image['quantification']['mean']);
                    this.$('.g-quant2-sd').text(image['quantification']['sd']);
                    this.$('.g-quant2-volume').text(image['quantification']['volume']);
                }

                this._seg2View
                    .setImage(image)
                    .setLabelValue(labelValue)
                    .rerenderSlice();

                this._updateDiffImageIfReady();
            });
        if (isNewFile) {
            this._updateSegmentationInfo(selectedFile, '.g-seg2-tag', '.g-seg2-comment');
        }
    },
    _onBaseImageSelectionChanged: function (selectedFile) {
        let isNewFile = false;
        if (selectedFile != this._baseImageFile) {
            isNewFile = true;
            this._baseImageFile = selectedFile;
            console.log('[SegItemView::_onBaseImageSelectionChanged] calling with new file: ', selectedFile);
        }
        selectedFile.getImage(this._slice)
            .then((image) => {
                if (isNewFile){
                    // Only update if base image has changed
                    this._baseImageView.$('.g-filename').text(selectedFile.name()).attr('title', selectedFile.name());
                    this._setSliceCount();
                }

                this._baseImageView
                    .setImage(image)
                    .rerenderSlice();
            });
    },
    _setDiffImage: function () {
        this._updateDiffImageIfReady();
    },
    _updateDiffImageIfReady: function () {
        // Only proceed if both segmentation files are selected
        if (!this._seg1File || !this._seg2File) {
            return;
        }

        // this._toggleControls(false);
        const diffInfo = {
            seg1_id: this._seg1File.id,
            seg2_id: this._seg2File.id
        };

        // Create a temporary file model to handle the diff request
        const diffFileModel = new ImageFileModel();
        diffFileModel.getImage(this._slice, false, diffInfo)
            .then((diffImage) => {
                this.$('.g-seg-diff-filename').text('Difference').attr('title', 'Difference');
                this._diffView
                    .setImage(diffImage)
                    .rerenderSlice();
                // update metrics
                this.$('.g-seg-metrics-dice').text('0.804');
                this.$('.g-seg-metrics-hausdorff').text('1.3');
                this.$('.g-seg-metrics-assd').text('0.2');
            });
    },
    _setSliceCount: function () {
        let sliceCount = 0;
        try {
            sliceCount = this._baseImageFile.getSliceCount();
            console.log('[SegItemView::render] getting sliceCount: ', sliceCount);
        } catch (e) {
            console.error('[SegItemView::render] Error getting slice count:', e);
            sliceCount = 1;
        }
        this._sliceCount = sliceCount;
        this.$('.g-slice-slider').attr('max', this._sliceCount - 1).val(this._slice);
        this.$('.g-slice-value').attr('max', this._sliceCount - 1).val(this._slice);
    },
    _updateSegmentationInfo: function (selectedFile, tagSelector, commentSelector) {
        selectedFile.getFileInfo().then((info) => {
            console.log('[SegItemView::_updateSegmentationInfo] file info: ', info);
            this.$(tagSelector).val(info.tag);
            this.$(commentSelector).val(info.comment);
        });
    },
    _rerender: function () {
        this._volumeFiles.selectVolumeIndex(this._volumeFiles._selectedVolume);
        this._files.selectSeg1Index(this._files._selectedSeg1);
        this._files.selectSeg2Index(this._files._selectedSeg2);
        this._updateDiffImageIfReady();
    },
    _populateSegDropdowns: function () {
        // Clear existing options
        this.$('.g-seg1-options').empty();
        this.$('.g-seg2-options').empty();
    
        // Get selected indices
        const selectedSeg1 = this._files._selectedSeg1;
        const selectedSeg2 = this._files._selectedSeg2;
    
        // Populate both dropdowns with the same files
        this._files.each((file, index) => {
            const fileName = file.name() || `Segmentation ${index + 1}`;
    
            // Disable option in seg1 if selected in seg2
            const seg1Disabled = (index === selectedSeg2) ? 'class="disabled" tabindex="-1" aria-disabled="true"' : '';
            this.$('.g-seg1-options').append(
                `<li><a href="#" data-index="${index}" ${seg1Disabled}>${fileName}</a></li>`
            );
    
            // Disable option in seg2 if selected in seg1
            const seg2Disabled = (index === selectedSeg1) ? 'class="disabled" tabindex="-1" aria-disabled="true"' : '';
            this.$('.g-seg2-options').append(
                `<li><a href="#" data-index="${index}" ${seg2Disabled}>${fileName}</a></li>`
            );
        });
    
        // Set initial dropdown text if files are available
        if (this._files.length > 0) {
            const firstFileName = this._files.at(selectedSeg1).name() || 'Segmentation 1';
            this._updateDropdownText('.g-seg1-dropdown', firstFileName);
    
            if (this._files.length > 1) {
                const secondFileName = this._files.at(selectedSeg2).name() || 'Segmentation 2';
                this._updateDropdownText('.g-seg2-dropdown', secondFileName);
            }
        }
    },
    _populateVolumeDropdown: function () {
        this.$('.g-volume-options').empty();

        this._volumeFiles.each((file, index) => {
            const fileName = file.name() || `Segmentation ${index + 1}`;

            this.$('.g-volume-options').append(
                `<li><a href="#" data-index="${index}">${fileName}</a></li>`
            );
        });

        if (this._volumeFiles.length > 0) {
            const firstFileName = this._volumeFiles.at(0).name() || 'Segmentation 1';
            this._updateDropdownText('.g-volume-dropdown', firstFileName);
        }
    },
    _populateLabelDropdowns: function (image, dropdownElement, dropdownSelector) {
        // Update the label dropdowns with the current segmentation file names
        if(image.labels && image.labels.length > 0) {
            this.$(dropdownElement).empty();
            this.$(dropdownElement).append(
                `<li><a href="#" data-label="${-1}" >${`All labels`}</a></li>`
            );
            image.labels.forEach((label) => {
                this.$(dropdownElement).append(
                    `<li><a href="#" data-label="${label.value}">${`Label ${label.value}`}</a></li>`
                );
            });

            this._updateDropdownText(dropdownSelector, 'All labels');
        }
    },
    _updateDropdownText: function (dropdownSelector, text) {
        // Update the dropdown button text while preserving the caret
        const $button = this.$(dropdownSelector).find('.dropdown-toggle');
        $button.contents().filter(function() {
            return this.nodeType === 3; // Text node
        }).remove();
        $button.prepend(text + ' ');
    },
});

export default SegItemView;
