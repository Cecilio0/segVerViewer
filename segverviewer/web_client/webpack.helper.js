const babelPresets = require.resolve('babel-preset-env');

module.exports = function (config) {
    // Shader loader for vtk.js
    config.module.rules.push({
        resource: {
            test: /node_modules[\/\\]vtk\.js[\/\\].*\.glsl$/,
            include: [/node_modules[\/\\]vtk\.js[\/\\]/]
        },
        use: [
            require.resolve('shader-loader')
        ]
    });

    // Babel transpile vtk.js to ES5 for old UglifyJS compatibility
    config.module.rules.push({
        resource: {
            test: /node_modules[\/\\]vtk\.js[\/\\].*\.js$/,
            include: [/node_modules[\/\\]vtk\.js[\/\\]/]
        },
        use: [
            {
                loader: 'babel-loader',
                options: {
                    presets: [babelPresets],
                    cacheDirectory: true
                }
            }
        ]
    });

    return config;
};
